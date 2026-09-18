/**
 * The partner balance on hold after a password recovery by subscription link.
 *
 * For a while after the password was reset with a subscription link, the panel
 * lets no money leave the partner balance — no withdrawal request, and no
 * purchase paid with it. A subscription link is often shared, so this is what
 * stops whoever used it from spending the owner's money before the owner
 * notices. The customer learns of it two ways: ahead of time, from the partner
 * info (`balanceHold`), and after the fact, from a refused payment (the cabinet
 * forwards `WITHDRAWAL_HOLD_AFTER_RECOVERY` with `holdUntil`). Both come through
 * here, so every place that offers the balance says the same thing: it is
 * temporary, why, and until when.
 */

export const BALANCE_HOLD_CODE = "WITHDRAWAL_HOLD_AFTER_RECOVERY";

export interface PartnerBalanceHold {
  /** When the hold ends, as an ISO-8601 instant. */
  readonly until: string;
  /** The operator's IANA time zone (panel → Branding), or `null` when none is set. */
  readonly timezone: string | null;
}

/**
 * The hold as it stands at `now`, or `null` when there is none — including one
 * whose end has already passed while the partner info sat in the cache.
 */
export function standingBalanceHold(
  hold: PartnerBalanceHold | null | undefined,
  now: number = Date.now(),
): PartnerBalanceHold | null {
  if (!hold || typeof hold.until !== "string") return null;
  const end = Date.parse(hold.until);
  if (Number.isNaN(end) || end <= now) return null;
  return hold;
}

/**
 * The hold behind a refused `/partner/pay` or `/partner/withdraw`, or `null`
 * when the refusal is anything else. `until` is `null` when the answer carried
 * no usable end.
 */
export function readBalanceHoldRefusal(err: unknown): { readonly until: string | null } | null {
  if (typeof err !== "object" || err === null) return null;
  const response = (err as { response?: { status?: unknown; data?: unknown } }).response;
  if (!response || response.status !== 400) return null;
  const data = response.data;
  if (typeof data !== "object" || data === null) return null;
  if ((data as { code?: unknown }).code !== BALANCE_HOLD_CODE) return null;
  const until = (data as { holdUntil?: unknown }).holdUntil;
  return { until: typeof until === "string" && !Number.isNaN(Date.parse(until)) ? until : null };
}

/**
 * What to tell the customer when a payment or a withdrawal was refused for the
 * hold, or `null` when the refusal is anything else. `timezone` is the
 * operator's, from the partner info the page holds — `null` when that copy
 * predates the hold, and the end is then given in UTC, named as such.
 */
export function balanceHoldRefusalMessage(
  err: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
  timezone: string | null,
  locale: string,
): string | null {
  const hold = readBalanceHoldRefusal(err);
  if (hold === null) return null;
  return hold.until
    ? t("partnerBalanceHold.refusedUntil", { until: formatHoldEnd(hold.until, timezone, locale) })
    : t("partnerBalanceHold.refused");
}

const HOLD_END_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/**
 * The end of the hold for a sentence — «21 сентября в 14:30 GMT+3». In the
 * operator's time zone when there is one this browser knows, otherwise in UTC.
 * The zone is named either way, so the hour can never be read in the wrong one.
 */
export function formatHoldEnd(until: string, timezone: string | null, locale: string): string {
  const instant = new Date(until);
  if (timezone) {
    try {
      return new Intl.DateTimeFormat(locale, { ...HOLD_END_FORMAT, timeZone: timezone }).format(instant);
    } catch {
      // A zone this browser does not know: UTC below, named as such.
    }
  }
  return new Intl.DateTimeFormat(locale, { ...HOLD_END_FORMAT, timeZone: "UTC" }).format(instant);
}
