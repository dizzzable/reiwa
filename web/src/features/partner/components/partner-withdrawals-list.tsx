/**
 * The partner's withdrawal requests and where each one stands.
 *
 * What the statuses mean, from the panel's side: a request is created PENDING
 * and its amount leaves the balance at once; the operator pays it by hand and
 * marks it COMPLETED, or rejects it — REJECTED, and the amount goes back on the
 * balance (`PartnersService.rejectWithdrawal`), usually with a comment saying
 * why. CANCELED is in the panel's vocabulary but nothing sets it, so nothing is
 * claimed about its money. A status this build does not know is shown as it
 * came rather than guessed at.
 */

import { useTranslation } from "react-i18next";

import {
  PARTNER_WITHDRAWAL_METHODS,
  type PartnerWithdrawal,
  type PartnerWithdrawalMethod,
} from "@/lib/api-client/partner";
import { cn, formatDateTime } from "@/lib/utils";

import { formatPartnerMoney } from "../partner-withdraw-policy";

const KNOWN_STATUSES = ["PENDING", "COMPLETED", "REJECTED", "CANCELED"] as const;
type KnownStatus = (typeof KNOWN_STATUSES)[number];

const STATUS_TONE: Readonly<Record<KnownStatus, string>> = {
  PENDING: "bg-amber-500/15 text-amber-400",
  COMPLETED: "bg-emerald-500/15 text-emerald-400",
  REJECTED: "bg-red-500/15 text-red-400",
  CANCELED: "bg-[var(--color-surface-high)] text-[var(--brand-muted-foreground)]",
};

function isKnownStatus(status: string): status is KnownStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(status);
}

export function isKnownWithdrawalMethod(method: string): method is PartnerWithdrawalMethod {
  return (PARTNER_WITHDRAWAL_METHODS as readonly string[]).includes(method);
}

export function PartnerWithdrawalsList({
  withdrawals,
  currency,
}: {
  withdrawals: readonly PartnerWithdrawal[];
  currency: string | null;
}) {
  const { t } = useTranslation();

  // Nothing at all rather than "no requests yet": the cabinet answers an empty
  // list both when there are none and when the panel could not be asked, and
  // an empty state is a claim about data this list cannot vouch for.
  if (withdrawals.length === 0) return null;

  return (
    <section className="space-y-2" aria-labelledby="partner-withdrawals-title" data-testid="partner-withdrawals">
      <p id="partner-withdrawals-title" className="text-xs font-medium text-[var(--brand-muted-foreground)]">
        {t("partnerWithdraw.history.title")}
      </p>
      <ul className="space-y-2">
        {withdrawals.map((row) => {
          const known = isKnownStatus(row.status);
          const statusLabel = known
            ? t(`partnerWithdraw.history.statuses.${row.status}`)
            : t("partnerWithdraw.history.unknownStatus", { status: row.status });
          const methodLabel = isKnownWithdrawalMethod(row.method)
            ? t(`partnerWithdraw.methods.${row.method}`)
            : row.method;
          return (
            <li
              key={row.id}
              data-testid="partner-withdrawal"
              data-status={row.status}
              className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] p-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--brand-foreground)]">
                    {formatPartnerMoney(row.amount, currency)}
                  </p>
                  <p className="text-[10px] text-[var(--brand-muted-foreground)]">
                    {t("partnerWithdraw.history.requested", { date: formatDateTime(row.createdAt) })}
                  </p>
                </div>
                <span
                  data-testid="partner-withdrawal-status"
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    known ? STATUS_TONE[row.status as KnownStatus] : STATUS_TONE.CANCELED,
                  )}
                >
                  {statusLabel}
                </span>
              </div>
              <p className="mt-1 break-words text-[11px] text-[var(--brand-muted-foreground)]">
                {methodLabel}
                {row.requisites ? ` · ${row.requisites}` : ""}
              </p>
              {row.status === "REJECTED" && (
                <p className="mt-1 text-[11px] text-[var(--brand-muted-foreground)]">
                  {t("partnerWithdraw.history.refunded")}
                </p>
              )}
              {row.adminComment && (
                <p className="mt-1 break-words text-[11px] text-[var(--brand-foreground)]">
                  {t("partnerWithdraw.history.comment", { comment: row.adminComment })}
                </p>
              )}
              {row.processedAt && row.status !== "PENDING" && (
                <p className="mt-1 text-[10px] text-[var(--brand-muted-foreground)]">
                  {t("partnerWithdraw.history.processed", { date: formatDateTime(row.processedAt) })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
