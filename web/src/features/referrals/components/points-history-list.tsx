/**
 * PointsHistoryList
 * ─────────────────
 * The subscriber's own points ledger, newest first, inside the points
 * dialog. Keyset-paginated: the panel hands back an opaque `nextCursor`
 * and "show more" hands it straight back.
 *
 * Three things here are not cosmetic:
 *
 *   1. A panel older than the ledger route answers 404. That is NOT an
 *      error to show — it means this install has no such history at all,
 *      so the component renders NOTHING and the dialog closes over the
 *      gap. An error card here would tell the customer something broke
 *      when nothing did, and an empty-state would claim they had earned
 *      nothing, which is a different lie.
 *
 *   2. `details` is whatever the panel put there. It is read through
 *      narrowing helpers and every enum value is checked against the set
 *      this build knows: an unrecognised one renders no line rather than
 *      the raw `pointsHistory.reasons.WHATEVER` i18n key.
 *
 *   3. MANUAL_ADJUSTMENT details carry `note` and `adminId`. Those are
 *      operator-to-operator bookkeeping — the subscriber sees the REASON
 *      LABEL and nothing else. Do not "helpfully" surface the note.
 *
 * Rows scroll inside a bounded box because the host dialog is `max-w-sm`
 * and centred: an unbounded list pushes its own footer off-screen.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { History, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getPointsLedger, type PointsLedgerEntry } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 20;

/** Sources this build can name. Anything else is newer than this SPA. */
const KNOWN_SOURCES = new Set([
  "CASHBACK",
  "CASHBACK_REVERSED",
  "REFERRAL_REWARD",
  "REFERRAL_REWARD_REVOKED",
  "QUEST_REWARD",
  "EXCHANGE",
  "MANUAL_ADJUSTMENT",
  "ACCOUNT_MERGE",
  "IMPORT",
  "OPENING_BALANCE",
]);

const KNOWN_REASONS = new Set([
  "COMPENSATION",
  "PROMOTION",
  "CORRECTION",
  "VIOLATION",
  "OTHER",
]);

const KNOWN_EXCHANGE_TYPES = new Set([
  "SUBSCRIPTION_DAYS",
  "GIFT_SUBSCRIPTION",
  "DISCOUNT",
  "TRAFFIC",
]);

// ── Defensive readers ────────────────────────────────────────────────────
// `details` is typed `unknown` on purpose: the shape differs per source,
// older panels omit fields, and a `.` into a missing object is a blank
// dialog rather than a missing line.

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Quest titles arrive either as a plain string or as `{ ru, en }`. */
function localizedTitle(value: unknown, language: string): string | null {
  const plain = asText(value);
  if (plain !== null) return plain;
  const record = asRecord(value);
  if (record === null) return null;
  const key = language.startsWith("ru") ? "ru" : "en";
  return asText(record[key]) ?? asText(record["en"]) ?? asText(record["ru"]);
}

function formatMoment(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(language, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(source: string, t: TFunction): string {
  // An unknown source still moved a real balance, so the row stays; it is
  // named by its raw code rather than by a key that does not exist.
  return KNOWN_SOURCES.has(source) ? t(`pointsHistory.sources.${source}`) : source;
}

/**
 * One line of plain-language context under the source label, or `null`
 * when the panel gave nothing worth saying.
 */
function describe(entry: PointsLedgerEntry, t: TFunction, language: string): string | null {
  const details = asRecord(entry.details);
  const parts: string[] = [];

  if (details !== null) {
    switch (entry.source) {
      case "CASHBACK": {
        const rawLines = Array.isArray(details["lines"]) ? (details["lines"] as unknown[]) : [];
        const named = rawLines
          .map((line) => {
            const record = asRecord(line);
            if (record === null) return null;
            const name = asText(record["name"]);
            if (name === null) return null;
            const days = asFiniteNumber(record["durationDays"]);
            return days !== null && days > 0
              ? `${name} (${t("pointsHistory.details.days", { count: days })})`
              : name;
          })
          .filter((line): line is string => line !== null);
        const amount = asText(details["paidAmount"]);
        const currency = asText(details["paidCurrency"]);
        if (named.length > 0 && amount !== null) {
          parts.push(
            t("pointsHistory.details.cashback", {
              what: named.join(", "),
              amount: currency !== null ? `${amount} ${currency}` : amount,
            }),
          );
        }
        break;
      }
      case "CASHBACK_REVERSED": {
        const applied = asFiniteNumber(details["applied"]);
        const requested = asFiniteNumber(details["requested"]);
        if (applied !== null && requested !== null) {
          parts.push(t("pointsHistory.details.reversal", { applied, requested }));
        }
        break;
      }
      case "QUEST_REWARD": {
        const title = localizedTitle(details["questTitle"], language);
        if (title !== null) parts.push(t("pointsHistory.details.quest", { title }));
        break;
      }
      case "EXCHANGE": {
        const type = asText(details["exchangeType"]);
        if (type !== null && KNOWN_EXCHANGE_TYPES.has(type)) {
          parts.push(
            t("pointsHistory.details.exchange", { type: t(`pointsHistory.exchange.${type}`) }),
          );
        }
        break;
      }
      case "MANUAL_ADJUSTMENT": {
        // REASON ONLY. `note` and `adminId` sit next to it in the payload
        // and must never reach this list.
        const reason = asText(details["reason"]);
        if (reason !== null && KNOWN_REASONS.has(reason)) {
          parts.push(t(`pointsHistory.reasons.${reason}`));
        }
        break;
      }
      default:
        break;
    }

    // A floored award carries what it could not pay, whatever the source.
    const shortfall = asFiniteNumber(details["shortfall"]);
    if (shortfall !== null && shortfall > 0) {
      parts.push(t("pointsHistory.details.shortfall", { count: shortfall }));
    }
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/** True only for the "this panel has no ledger route" answer. */
function isNotFound(error: unknown): boolean {
  const response = asRecord(asRecord(error)?.["response"]);
  return response !== null && response["status"] === 404;
}

export function PointsHistoryList() {
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? "ru";

  const { data, error, isPending, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useInfiniteQuery({
      queryKey: ["referrals", "points", "ledger"],
      queryFn: ({ pageParam }) => getPointsLedger(pageParam, PAGE_SIZE),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      staleTime: 30_000,
      // Retrying a 404 delays the "render nothing" decision by seconds of
      // backoff on every install with an older panel.
      retry: (failureCount, retryError) => !isNotFound(retryError) && failureCount < 2,
    });

  // The panel predates the route: there is no history here to speak of.
  if (error !== null && isNotFound(error)) return null;

  const entries = (data?.pages ?? []).flatMap((page) => page.items ?? []);

  return (
    <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-(--brand-primary)" />
        <p className="text-sm font-semibold text-[var(--brand-foreground)]">
          {t("pointsHistory.title")}
        </p>
      </div>

      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </div>
      ) : error !== null ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-xs text-[var(--brand-muted-foreground)]">
            {t("pointsHistory.loadError")}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] px-3 py-1.5 text-xs font-medium text-[var(--brand-foreground)] transition-colors hover:bg-[var(--color-surface)]"
          >
            {t("pointsHistory.retry")}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-surface-high)]">
            <History className="h-5 w-5 text-[var(--brand-muted-foreground)]" />
          </div>
          <p className="text-xs text-[var(--brand-muted-foreground)]">
            {t("pointsHistory.empty")}
          </p>
        </div>
      ) : (
        <>
          <div className="scroll-area max-h-64 space-y-2 overflow-y-auto">
            {entries.map((entry) => {
              const detail = describe(entry, t, language);
              const credited = entry.delta >= 0;
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-[var(--brand-foreground)]">
                      {sourceLabel(entry.source, t)}
                    </p>
                    {detail !== null && (
                      <p className="mt-0.5 truncate text-[11px] text-[var(--brand-muted-foreground)]">
                        {detail}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] text-[var(--brand-muted-foreground)]">
                      {formatMoment(entry.createdAt, language)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={
                        credited
                          ? "text-sm font-semibold text-emerald-400"
                          : "text-sm font-semibold text-red-400"
                      }
                    >
                      {credited ? `+${entry.delta}` : String(entry.delta)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-[var(--brand-muted-foreground)]">
                      {t("pointsHistory.balanceAfter", { count: entry.balanceAfter })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {hasNextPage && (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] px-3 py-2 text-xs font-medium text-[var(--brand-muted-foreground)] transition-colors hover:text-[var(--brand-foreground)] disabled:pointer-events-none disabled:opacity-50"
            >
              {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("pointsHistory.showMore")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
