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

/**
 * The other refusals of a withdrawal request, each with its own code
 * (rezeis-admin `partners/utils/partner-withdrawal-rules.ts`, allowlisted by its
 * error filter). Stripped down to "Withdrawal request failed" the customer was
 * sent to try again at a refusal that would not change — or told nothing at
 * all about a minimum. Forwarded like the hold: the code, the panel's own
 * status, a fixed message — never the panel's sentence — and for the minimum,
 * the minimum itself. A panel from before these codes answers without them,
 * and the generic handling below takes over as it always did.
 */
export const PARTNER_WITHDRAWAL_REFUSAL_CODES = [
  "PARTNER_NOT_FOUND",
  "PARTNER_PROGRAM_INVITED_ONLY",
  "PARTNER_NOT_ACTIVE",
  "WITHDRAWAL_INSUFFICIENT_BALANCE",
  "WITHDRAWAL_BELOW_MINIMUM",
] as const;
export type PartnerWithdrawalRefusalCode = (typeof PARTNER_WITHDRAWAL_REFUSAL_CODES)[number];

const REFUSAL_MESSAGES: Readonly<Record<PartnerWithdrawalRefusalCode, string>> = {
  PARTNER_NOT_FOUND: "Partner not found",
  PARTNER_PROGRAM_INVITED_ONLY: "The partner program is open to invited users only",
  PARTNER_NOT_ACTIVE: "Partner is not active",
  WITHDRAWAL_INSUFFICIENT_BALANCE: "Insufficient partner balance",
  WITHDRAWAL_BELOW_MINIMUM: "The amount is below the minimum withdrawal",
};

export interface PartnerWithdrawalRefusal {
  /**
   * The panel's own 4xx: 409 for the program's or the partner's state (no
   * partner, invited-only, switched off), 422 for an amount it cannot take
   * (more than the balance, below the minimum). Never 401/403, which this
   * client reads as the panel rejecting its token.
   */
  readonly status: number;
  readonly body: {
    readonly code: PartnerWithdrawalRefusalCode;
    readonly message: string;
    /** Minor units; only on `WITHDRAWAL_BELOW_MINIMUM`, and only when the panel sent a whole number. */
    readonly minWithdrawalAmount?: number;
  };
}

const FORWARDED_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422]);

function isRefusalCode(value: unknown): value is PartnerWithdrawalRefusalCode {
  return (PARTNER_WITHDRAWAL_REFUSAL_CODES as readonly unknown[]).includes(value);
}

/**
 * The coded refusal inside a failed withdraw call, or `null` when the failure
 * is anything else — including the hold, which `readBalanceHoldRefusal` reads.
 */
export function readPartnerWithdrawalRefusal(e: unknown): PartnerWithdrawalRefusal | null {
  // Only statuses that mean a refusal. A 401 forwarded to the browser would
  // send the customer to sign-in, and 401/403 from the panel mean this
  // cabinet's own credentials, whatever the body says.
  if (!(e instanceof UpstreamError) || !FORWARDED_STATUSES.has(e.status)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(e.body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as { code?: unknown; errorCode?: unknown; minWithdrawalAmount?: unknown };
  const code = typeof body.code === "string" ? body.code : body.errorCode;
  if (!isRefusalCode(code)) return null;
  const minimum = body.minWithdrawalAmount;
  const carriesMinimum =
    code === "WITHDRAWAL_BELOW_MINIMUM" &&
    typeof minimum === "number" &&
    Number.isSafeInteger(minimum) &&
    minimum >= 0;
  return {
    status: e.status,
    body: {
      code,
      message: REFUSAL_MESSAGES[code],
      ...(carriesMinimum ? { minWithdrawalAmount: minimum } : {}),
    },
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
