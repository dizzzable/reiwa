import { UpstreamError } from "../../core/errors/upstream-error.js";

/**
 * The partner balance held after a password recovery by subscription link.
 *
 * For three days after such a recovery the panel lets no money leave the
 * balance — neither a withdrawal request nor a purchase paid with it — and
 * refuses both with this code and the end of the hold (`holdUntil`). Stripped
 * down to "Withdrawal request failed", the customer could not tell a temporary
 * hold from a broken button, so this one refusal is forwarded as it is: the
 * code, the end of the hold, and a fixed message. The panel's own sentence is
 * not passed on; the page words it in the customer's language.
 *
 * Every other refusal on these routes keeps the generic handling.
 */
export const BALANCE_HOLD_CODE = "WITHDRAWAL_HOLD_AFTER_RECOVERY";

export interface BalanceHoldRefusal {
  readonly code: typeof BALANCE_HOLD_CODE;
  /** When the hold ends, as an ISO-8601 instant; `null` when the panel did not say. */
  readonly holdUntil: string | null;
  readonly message: string;
}

/**
 * The hold refusal inside a failed panel call, or `null` when the failure is
 * anything else. Read from the typed upstream error only — a 400 from the
 * panel whose `code` (or the filter's `errorCode`) is exactly this one.
 */
export function readBalanceHoldRefusal(e: unknown): BalanceHoldRefusal | null {
  if (!(e instanceof UpstreamError) || e.status !== 400) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(e.body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as { code?: unknown; errorCode?: unknown; holdUntil?: unknown };
  const code = typeof body.code === "string" ? body.code : body.errorCode;
  if (code !== BALANCE_HOLD_CODE) return null;
  return {
    code: BALANCE_HOLD_CODE,
    holdUntil: exactInstant(body.holdUntil),
    message: "The partner balance is on hold after an account recovery",
  };
}

/** An ISO-8601 instant exactly as `Date#toISOString` writes it, or `null`. */
function exactInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const serialised = instant.toISOString();
  return serialised === value ? serialised : null;
}
