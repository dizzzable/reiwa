/**
 * «Вывести средства» — the partner's withdrawal request, in three steps: what
 * and where, a look before sending, and the request as the panel created it.
 *
 * ── What happens after «Отправить заявку» ─────────────────────────────────
 *
 * The panel takes the amount off the balance at once and files a PENDING
 * request. An operator pays it BY HAND, outside the product, and marks it paid
 * in «Выплаты партнёрам» — or rejects it, which puts the amount back on the
 * balance. The copy here says exactly that and promises no timing, because the
 * panel has none to keep.
 *
 * ── Refusals ────────────────────────────────────────────────────────────────
 *
 * The panel's refusals arrive four ways, and each is read where it arrives:
 *   - a coded 409 or 422 (not a partner, invited-only program, partner switched
 *     off, more than the balance, below the minimum), forwarded by the cabinet
 *     (`readWithdrawalRefusal`) — each in its own words, the partner info read
 *     again so the page shows the balance and the minimum as they now stand;
 *   - the recovery hold, forwarded with its code and end — worded exactly as
 *     the purchase and renewal pages word it, and the partner info re-read so
 *     the standing notice takes over;
 *   - from a panel from before the codes, a 2xx body `{ error }` (invited-only
 *     program, not a partner) — a request "that worked" unless the body is
 *     read (`readWithdrawalAnswer`);
 *   - from the same older panel, every other 400, stripped of its reason by the
 *     cabinet. The partner info and the request list are read again and the
 *     refusal is explained from what they now say — and a request that DID get
 *     created (the answer was lost, not the request) is shown as created, so a
 *     second tap cannot take the money twice.
 *
 * Before any of those, the cabinet's fresh session check (`lib/session-check.ts`,
 * the same reader the purchase and renewal pages use): `unavailable` — the panel
 * could not say whether this session was signed out, so NOTHING was done — gets
 * its own words and leaves the summary up for another try; `revoked`, like any
 * 401, says nothing here, because the transport is already taking the customer
 * to sign-in.
 */

import { useRef, useState, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CheckCircle2 } from "lucide-react";

import { createWithdrawal, getPartnerInfo } from "@/lib/api-client";
import {
  PARTNER_WITHDRAWAL_METHODS,
  PARTNER_WITHDRAWAL_REQUISITES_MAX_LENGTH,
  readWithdrawalAnswer,
  readWithdrawalRefusal,
  type PartnerInfo,
  type PartnerWithdrawal,
  type PartnerWithdrawalMethod,
  type PartnerWithdrawalRefusalCode,
} from "@/lib/api-client/partner";
import { balanceHoldRefusalMessage, formatHoldEnd } from "@/lib/partner-balance-hold";
import { readSessionCheckRefusal } from "@/lib/session-check";
import { cn, formatDateTime } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";

import { PartnerBalanceHoldNotice } from "../partner-balance-hold-notice";
import {
  fetchPartnerWithdrawals,
  PARTNER_INFO_QUERY_KEY,
  PARTNER_WITHDRAWALS_QUERY_KEY,
} from "../partner-queries";
import {
  checkWithdrawalRequisites,
  explainWithdrawalRefusal,
  findRequestCreatedAnyway,
  formatAmountForInput,
  formatPartnerMoney,
  parseWithdrawalAmount,
  withdrawalBlock,
  withdrawalMinimum,
  type WithdrawalBlock,
} from "../partner-withdraw-policy";
import { isKnownWithdrawalMethod } from "./partner-withdrawals-list";

type Step = "form" | "confirm" | "done";

const BLOCK_NOTICE_ID = "partner-withdraw-dialog-block";
const AMOUNT_ID = "partner-withdraw-amount";
const AMOUNT_HELP_ID = "partner-withdraw-amount-help";
const AMOUNT_ERROR_ID = "partner-withdraw-amount-error";
const REQUISITES_ID = "partner-withdraw-requisites";
const REQUISITES_ERROR_ID = "partner-withdraw-requisites-error";

export function PartnerWithdrawDialog({
  open,
  onOpenChange,
  info,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The partner info the page holds; `null` when it has none. */
  info: PartnerInfo | null;
  /** «Готово» after a created request: the page shows the balance and the list. */
  onFinished: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-y-auto"
        aria-describedby={undefined}
        data-testid="partner-withdraw-dialog"
      >
        <SheetHeader>
          <SheetTitle>{t("partnerWithdraw.title")}</SheetTitle>
        </SheetHeader>
        {/* Mounted per opening, so every opening starts from an empty form. */}
        {open && <WithdrawFlow info={info} onFinished={onFinished} />}
      </SheetContent>
    </Sheet>
  );
}

function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === "number" ? status : null;
}

/** The ids on the list the customer had before this tap, or `null` when it was never read. */
function requestIdsOnScreen(queryClient: QueryClient): ReadonlySet<string> | null {
  const rows = queryClient.getQueryData<PartnerWithdrawal[]>(PARTNER_WITHDRAWALS_QUERY_KEY);
  return Array.isArray(rows) ? new Set(rows.map((row) => row.id)) : null;
}

function WithdrawFlow({ info, onFinished }: { info: PartnerInfo | null; onFinished: () => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("form");
  const [amountText, setAmountText] = useState("");
  const [method, setMethod] = useState<PartnerWithdrawalMethod>("card");
  const [requisites, setRequisites] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [created, setCreated] = useState<PartnerWithdrawal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A second tap in the same frame, before `submitting` re-renders the button
  // disabled, must not become a second request: each one takes money.
  const inFlight = useRef(false);

  const balance = typeof info?.balance === "number" && Number.isFinite(info.balance) ? info.balance : 0;
  const currency = info?.balanceCurrency ?? null;
  const money = (minor: number): string => formatPartnerMoney(minor, currency);
  const block = withdrawalBlock(info);
  // The operator's minimum, which the panel enforces; one minor unit without one.
  const minimum = withdrawalMinimum(info);
  const amount = parseWithdrawalAmount(amountText, balance, minimum);
  const details = checkWithdrawalRequisites(requisites);
  const methodLabel = (value: string): string =>
    isKnownWithdrawalMethod(value) ? t(`partnerWithdraw.methods.${value}`) : value;

  const amountError =
    !showErrors || amount.ok
      ? null
      : amount.error === "required"
        ? t("partnerWithdraw.errors.amountRequired")
        : amount.error === "invalid"
          ? t("partnerWithdraw.errors.amountInvalid")
          : amount.error === "tooSmall"
            ? t("partnerWithdraw.errors.amountTooSmall", { min: money(minimum) })
            : t("partnerWithdraw.errors.amountTooLarge", { max: money(balance) });
  const requisitesError =
    !showErrors || details.ok
      ? null
      : details.error === "required"
        ? t("partnerWithdraw.errors.requisitesRequired")
        : t("partnerWithdraw.errors.requisitesTooLong", { max: PARTNER_WITHDRAWAL_REQUISITES_MAX_LENGTH });

  const finish = (withdrawal: PartnerWithdrawal): void => {
    setCreated(withdrawal);
    setRefusal(null);
    setStep("done");
    void queryClient.invalidateQueries({ queryKey: PARTNER_INFO_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: PARTNER_WITHDRAWALS_QUERY_KEY });
  };

  const refusedFor = (code: PartnerWithdrawalRefusalCode): string =>
    code === "INVITED_ONLY"
      ? t("partnerWithdraw.refused.invitedOnly")
      : code === "NOT_A_PARTNER"
        ? t("partnerWithdraw.refused.notPartner")
        : t("partnerWithdraw.refused.failed");

  const explainFailure = async (
    error: unknown,
    asked: { amount: number; method: string; requisites: string },
    before: ReadonlySet<string> | null,
  ): Promise<void> => {
    const sessionRefusal = readSessionCheckRefusal(error);
    if (sessionRefusal === "revoked" || httpStatusOf(error) === 401) return;
    if (sessionRefusal === "unavailable") {
      // Nothing was sent to the panel, so there is nothing to re-read.
      setRefusal(t("auth.sessionCheckUnavailable"));
      return;
    }
    // The hold this copy of the partner info did not know about: the same words
    // as the purchase page — the zone from this copy, which predates the hold,
    // so UTC, named — and a re-read so the standing notice takes over.
    const holdMessage = balanceHoldRefusalMessage(
      error,
      t,
      info?.balanceHold?.timezone ?? null,
      i18n.language,
    );
    if (holdMessage !== null) {
      setRefusal(holdMessage);
      void queryClient.invalidateQueries({ queryKey: PARTNER_INFO_QUERY_KEY });
      return;
    }
    // A refusal the panel named with a code: its own words, and a re-read of
    // the partner info it depends on, so the form around it is current too.
    const coded = readWithdrawalRefusal(error);
    if (coded !== null) {
      const reread = (): Promise<PartnerInfo | null> =>
        queryClient
          .fetchQuery({ queryKey: PARTNER_INFO_QUERY_KEY, queryFn: getPartnerInfo, staleTime: 0 })
          .catch(() => null);
      switch (coded.code) {
        case "WITHDRAWAL_BELOW_MINIMUM": {
          // The operator may have raised it after this page read the info.
          const fresh = await reread();
          const least = coded.minWithdrawalAmount ?? withdrawalMinimum(fresh ?? info);
          setRefusal(t("partnerWithdraw.refused.belowMinimum", { min: money(least) }));
          setStep("form");
          return;
        }
        case "WITHDRAWAL_INSUFFICIENT_BALANCE": {
          const fresh = await reread();
          const current = typeof fresh?.balance === "number" ? fresh.balance : balance;
          setRefusal(t("partnerWithdraw.refused.insufficient", { balance: money(Math.max(0, current)) }));
          setStep("form");
          return;
        }
        case "PARTNER_NOT_ACTIVE":
          setRefusal(t("partnerWithdraw.refused.inactive"));
          break;
        case "PARTNER_PROGRAM_INVITED_ONLY":
          setRefusal(t("partnerWithdraw.refused.invitedOnly"));
          break;
        case "PARTNER_NOT_FOUND":
          setRefusal(t("partnerWithdraw.refused.notPartner"));
          break;
      }
      void queryClient.invalidateQueries({ queryKey: PARTNER_INFO_QUERY_KEY });
      return;
    }
    // A panel from before the codes: the refusal came without its reason, so
    // it is read back from what the partner info and the list now say.
    const [fresh, list] = await Promise.all([
      queryClient
        .fetchQuery({ queryKey: PARTNER_INFO_QUERY_KEY, queryFn: getPartnerInfo, staleTime: 0 })
        .catch(() => null),
      queryClient
        .fetchQuery({ queryKey: PARTNER_WITHDRAWALS_QUERY_KEY, queryFn: fetchPartnerWithdrawals, staleTime: 0 })
        .catch(() => null),
    ]);
    const createdAnyway = list === null ? null : findRequestCreatedAnyway(before, list, asked);
    if (createdAnyway !== null) {
      finish(createdAnyway);
      return;
    }
    const why = explainWithdrawalRefusal(fresh, asked.amount);
    switch (why.kind) {
      case "hold":
        setRefusal(
          t("partnerBalanceHold.refusedUntil", {
            until: formatHoldEnd(why.hold.until, why.hold.timezone, i18n.language),
          }),
        );
        return;
      case "invitedOnly":
        setRefusal(t("partnerWithdraw.refused.invitedOnly"));
        return;
      case "inactive":
        setRefusal(t("partnerWithdraw.refused.inactive"));
        return;
      case "insufficient":
        // Back to the amount, which is the one thing the customer can change.
        setRefusal(t("partnerWithdraw.refused.insufficient", { balance: money(why.balanceMinor) }));
        setStep("form");
        return;
      case "notPartner":
        setRefusal(t("partnerWithdraw.refused.notPartner"));
        return;
      case "failed":
        setRefusal(t("partnerWithdraw.refused.failed"));
        return;
    }
  };

  const submit = async (): Promise<void> => {
    if (inFlight.current || !amount.ok || !details.ok || block !== null) return;
    inFlight.current = true;
    setSubmitting(true);
    setRefusal(null);
    const asked = { amount: amount.minor, method, requisites: details.value };
    const before = requestIdsOnScreen(queryClient);
    try {
      let answer: unknown;
      try {
        answer = await createWithdrawal(asked);
      } catch (error: unknown) {
        await explainFailure(error, asked, before);
        return;
      }
      const read = readWithdrawalAnswer(answer);
      if (read.kind === "created") {
        finish(read.withdrawal);
        return;
      }
      setRefusal(refusedFor(read.code));
      void queryClient.invalidateQueries({ queryKey: PARTNER_INFO_QUERY_KEY });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const goNext = (): void => {
    setShowErrors(true);
    setRefusal(null);
    if (block !== null || !amount.ok || !details.ok) return;
    setStep("confirm");
  };

  if (step === "done" && created !== null) {
    return (
      <div className="space-y-4 py-2" data-testid="partner-withdraw-done">
        <div className="flex flex-col items-center gap-2 text-center" role="status">
          <CheckCircle2 className="h-10 w-10 text-emerald-400" aria-hidden />
          <p className="text-base font-semibold text-[var(--brand-foreground)]">{t("partnerWithdraw.doneTitle")}</p>
        </div>
        <SummaryRows>
          <SummaryRow label={t("partnerWithdraw.rowAmount")} value={money(created.amount)} />
          <SummaryRow label={t("partnerWithdraw.rowMethod")} value={methodLabel(created.method)} />
          <SummaryRow label={t("partnerWithdraw.rowRequisites")} value={created.requisites} />
          <SummaryRow
            label={t("partnerWithdraw.rowStatus")}
            value={
              created.status === "PENDING" ||
              created.status === "COMPLETED" ||
              created.status === "REJECTED" ||
              created.status === "CANCELED"
                ? t(`partnerWithdraw.history.statuses.${created.status}`)
                : t("partnerWithdraw.history.unknownStatus", { status: created.status })
            }
          />
          <SummaryRow label={t("partnerWithdraw.rowCreated")} value={formatDateTime(created.createdAt)} />
        </SummaryRows>
        <p className="text-xs text-[var(--brand-muted-foreground)]">{t("partnerWithdraw.doneBody")}</p>
        <StadiumButton fullWidth onClick={onFinished}>
          {t("partnerWithdraw.done")}
        </StadiumButton>
      </div>
    );
  }

  const blockNotice = block === null ? null : <BlockNotice block={block} currency={currency} />;
  const refusalNotice =
    refusal === null ? null : (
      <TipCard tone="danger" role="alert" data-testid="partner-withdraw-refusal">
        {refusal}
      </TipCard>
    );

  if (step === "confirm" && amount.ok && details.ok) {
    return (
      <div className="space-y-4 py-2" data-testid="partner-withdraw-confirm">
        <p className="text-sm font-medium text-[var(--brand-foreground)]">{t("partnerWithdraw.confirmTitle")}</p>
        {blockNotice}
        <SummaryRows>
          <SummaryRow label={t("partnerWithdraw.rowAmount")} value={money(amount.minor)} />
          <SummaryRow label={t("partnerWithdraw.rowMethod")} value={methodLabel(method)} />
          <SummaryRow label={t("partnerWithdraw.rowRequisites")} value={details.value} />
        </SummaryRows>
        <p className="text-xs text-[var(--brand-muted-foreground)]">
          {t("partnerWithdraw.confirmNote", { amount: money(amount.minor) })}
        </p>
        {refusalNotice}
        <div className="space-y-2">
          <StadiumButton
            fullWidth
            loading={submitting}
            disabled={block !== null}
            aria-describedby={block !== null ? BLOCK_NOTICE_ID : undefined}
            onClick={() => void submit()}
            data-testid="partner-withdraw-submit"
          >
            {t("partnerWithdraw.submit")}
          </StadiumButton>
          <StadiumButton
            fullWidth
            variant="ghost"
            disabled={submitting}
            onClick={() => {
              setRefusal(null);
              setStep("form");
            }}
          >
            {t("partnerWithdraw.edit")}
          </StadiumButton>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2" data-testid="partner-withdraw-form">
      <p className="text-sm text-[var(--brand-muted-foreground)]">
        {t("partnerWithdraw.available", { amount: money(balance) })}
      </p>
      {blockNotice}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={AMOUNT_ID} className="text-sm font-medium text-[var(--brand-foreground)]">
            {t("partnerWithdraw.amountLabel")}
          </label>
          <button
            type="button"
            className="text-xs font-medium text-(--brand-primary) disabled:opacity-40"
            disabled={balance < minimum}
            onClick={() => setAmountText(formatAmountForInput(balance))}
          >
            {t("partnerWithdraw.amountAll")}
          </button>
        </div>
        <input
          id={AMOUNT_ID}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amountText}
          onChange={(event) => setAmountText(event.target.value)}
          aria-invalid={amountError !== null}
          aria-describedby={amountError !== null ? `${AMOUNT_HELP_ID} ${AMOUNT_ERROR_ID}` : AMOUNT_HELP_ID}
          className="h-11 w-full rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-3 text-base text-[var(--brand-foreground)] outline-none focus-visible:border-(--brand-primary) aria-invalid:border-red-500/60"
        />
        <p id={AMOUNT_HELP_ID} className="text-xs text-[var(--brand-muted-foreground)]">
          {t("partnerWithdraw.amountLimits", {
            min: money(minimum),
            max: money(balance),
          })}
        </p>
        {amountError !== null && (
          <p id={AMOUNT_ERROR_ID} className="text-xs text-red-400" data-testid="partner-withdraw-amount-error">
            {amountError}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <p id="partner-withdraw-method-label" className="text-sm font-medium text-[var(--brand-foreground)]">
          {t("partnerWithdraw.methodLabel")}
        </p>
        <div role="radiogroup" aria-labelledby="partner-withdraw-method-label" className="grid grid-cols-2 gap-2">
          {PARTNER_WITHDRAWAL_METHODS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={method === value}
              data-method={value}
              onClick={() => setMethod(value)}
              className={cn(
                "rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                method === value
                  ? "border-(--brand-primary) bg-(--brand-primary)/10 text-[var(--brand-foreground)]"
                  : "border-[var(--color-border-soft)] bg-[var(--color-surface)] text-[var(--brand-muted-foreground)]",
              )}
            >
              {t(`partnerWithdraw.methods.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={REQUISITES_ID} className="text-sm font-medium text-[var(--brand-foreground)]">
          {t(`partnerWithdraw.requisitesLabel.${method}`)}
        </label>
        <textarea
          id={REQUISITES_ID}
          rows={2}
          value={requisites}
          placeholder={t(`partnerWithdraw.requisitesPlaceholder.${method}`)}
          onChange={(event) => setRequisites(event.target.value)}
          aria-invalid={requisitesError !== null}
          aria-describedby={requisitesError !== null ? REQUISITES_ERROR_ID : undefined}
          className="w-full rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--brand-foreground)] outline-none focus-visible:border-(--brand-primary) aria-invalid:border-red-500/60"
        />
        {requisitesError !== null ? (
          <p id={REQUISITES_ERROR_ID} className="text-xs text-red-400" data-testid="partner-withdraw-requisites-error">
            {requisitesError}
          </p>
        ) : (
          <p className="text-xs text-[var(--brand-muted-foreground)]">{t("partnerWithdraw.requisitesHint")}</p>
        )}
      </div>

      <p className="text-xs text-[var(--brand-muted-foreground)]">{t("partnerWithdraw.howItWorks")}</p>
      {refusalNotice}
      <StadiumButton
        fullWidth
        disabled={block !== null}
        aria-describedby={block !== null ? BLOCK_NOTICE_ID : undefined}
        onClick={goNext}
        data-testid="partner-withdraw-next"
      >
        {t("partnerWithdraw.next")}
      </StadiumButton>
    </div>
  );
}

function BlockNotice({ block, currency }: { block: WithdrawalBlock; currency: string | null }) {
  const { t } = useTranslation();
  if (block.kind === "hold") return <PartnerBalanceHoldNotice hold={block.hold} id={BLOCK_NOTICE_ID} />;
  return (
    <TipCard tone="warning" id={BLOCK_NOTICE_ID}>
      {withdrawalBlockText(block, t, currency)}
    </TipCard>
  );
}

/** The reason under a disabled «Вывести средства» that is not the hold. */
export function withdrawalBlockText(
  block: Exclude<WithdrawalBlock, { kind: "hold" }>,
  t: (key: string, options?: Record<string, unknown>) => string,
  currency: string | null,
): string {
  switch (block.kind) {
    case "invitedOnly":
      return t("partnerWithdraw.refused.invitedOnly");
    case "inactive":
      return t("partnerWithdraw.refused.inactive");
    case "empty":
      return t("partnerWithdraw.empty");
    case "belowMinimum":
      return t("partnerWithdraw.belowMinimum", {
        min: formatPartnerMoney(block.minimum, currency),
        balance: formatPartnerMoney(block.balance, currency),
      });
  }
}

function SummaryRows({ children }: { children: ReactNode }) {
  return (
    <dl className="divide-y divide-[var(--color-border-soft)] overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]">
      {children}
    </dl>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
      <dt className="shrink-0 text-[var(--brand-muted-foreground)]">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-[var(--brand-foreground)]">{value}</dd>
    </div>
  );
}
