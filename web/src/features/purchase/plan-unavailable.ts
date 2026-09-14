/**
 * A plan the panel no longer sells, met mid-checkout.
 *
 * The catalogue a subscriber picks from can be stale — React Query keeps it —
 * so an operator can archive or delete a plan that is still on their screen.
 * rezeis refuses that checkout before any draft or charge exists, and the BFF
 * forwards the refusal as `400 { code }` (`src/api/routes/payments-errors.ts`).
 * Purchase, upgrade and renewal all answer it the same way: say so, drop the
 * stale list, and go back to choosing.
 *
 * That answer is right ONLY for a plan that is gone from the list. Anything else
 * the panel will not sell is still listed — a paid trial this subscriber cannot
 * claim, above all — and "choose from the updated list" led straight back to it.
 */
import { toast } from "sonner";

/** The panel's code for a checkout whose plan or term is no longer offered. */
export const PLAN_UNAVAILABLE_REFUSAL_CODE = "PAYMENT_DRAFT_PLAN_NOT_AVAILABLE";

/**
 * The panel's code for every OTHER quote it will not turn into a draft — and,
 * from a panel older than the code above, for a withdrawn plan too. The panel's
 * safe filter strips the reasons, so the code alone cannot tell the two apart:
 * callers re-price the quote and let the fresh answer say which.
 */
export const QUOTE_NOT_ELIGIBLE_REFUSAL_CODE = "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE";

/** The forwarded refusal code. Reads the code only, never the message. */
function refusalCode(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  return typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined;
}

/** True for the BFF's forwarded "plan or term no longer offered" refusal. */
export function isPlanUnavailableRefusal(err: unknown): boolean {
  return refusalCode(err) === PLAN_UNAVAILABLE_REFUSAL_CODE;
}

/** True for the BFF's forwarded refusal that does not say why. */
export function isQuoteNotEligibleRefusal(err: unknown): boolean {
  return refusalCode(err) === QUOTE_NOT_ELIGIBLE_REFUSAL_CODE;
}

/** Quote warnings meaning the chosen plan or term is no longer offered. */
const WITHDRAWAL_WARNINGS: ReadonlySet<string> = new Set(["PLAN_NOT_AVAILABLE", "DURATION_NOT_AVAILABLE"]);

/**
 * Why a paid trial is not sold to THIS subscriber, with what to tell them. The
 * trial itself stays listed — the catalogue does not apply these checks — so
 * none of them is a withdrawal.
 */
export const TRIAL_CLAIM_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  TRIAL_REQUIRES_TELEGRAM: "trialCta.subtitleLinkTelegram",
  TRIAL_ALREADY_USED: "trialCta.errorAlreadyUsed",
  TRIAL_INVITED_ONLY: "trialCta.errorInvitedOnly",
};

/**
 * Every warning code of an unpriced quote, as the BFF flattens it: `warning` is
 * the first one, `warnings` all of them. The first alone is not enough — an
 * upgrade quote leads with its informational `UPGRADE_RESETS_EXPIRY`, and an
 * older panel put a trial's claim warning ahead of `PLAN_NOT_AVAILABLE` on
 * quotes for other plans.
 */
function quoteWarningCodes(quote: unknown): string[] {
  if (typeof quote !== "object" || quote === null) return [];
  const { warning, warnings } = quote as { warning?: unknown; warnings?: unknown };
  const codes = typeof warning === "string" ? [warning] : [];
  if (Array.isArray(warnings)) {
    for (const entry of warnings) {
      const code = typeof entry === "object" && entry !== null ? (entry as { code?: unknown }).code : undefined;
      if (typeof code === "string") codes.push(code);
    }
  }
  return codes;
}

/**
 * What an unpriced quote says about the plan it was asked for.
 *
 * - `trial`: the chosen paid trial is not sold to this subscriber, for `code`.
 * - `withdrawn`: the plan or its term is no longer offered.
 * - `null`: anything else, e.g. no price for the chosen payment method.
 *
 * A trial's claim warning is read only for a trial: an older panel attached it
 * to quotes for every plan while such a trial was listed, and there it explains
 * nothing about the plan that was actually chosen.
 */
export function readUnpricedQuote(
  quote: unknown,
  planIsTrial: boolean,
): { readonly kind: "trial"; readonly code: string } | { readonly kind: "withdrawn" } | null {
  const codes = quoteWarningCodes(quote);
  if (planIsTrial) {
    const claim = codes.find((code) => TRIAL_CLAIM_REFUSAL_KEYS[code] !== undefined);
    if (claim !== undefined) return { kind: "trial", code: claim };
  }
  return codes.some((code) => WITHDRAWAL_WARNINGS.has(code)) ? { kind: "withdrawn" } : null;
}

/**
 * A toast, not a dialog: every caller moves the subscriber onto a list that no
 * longer shows the plan, so the screen they land on carries the rest.
 */
export function notifyPlanUnavailable(t: (key: string) => string): void {
  toast.warning(t("purchase.checkout.planUnavailable"), { duration: 5_000 });
}
