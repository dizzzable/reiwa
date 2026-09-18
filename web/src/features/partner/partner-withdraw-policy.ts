/**
 * The partner withdrawal, as decisions — no React, no network.
 *
 * Every rule here is the panel's (see the notes on `PartnerWithdrawal` in
 * `lib/api-client/partner.ts`): a positive whole number of minor units, at most
 * the balance, free-text method and requisites. The cabinet checks the same
 * rules before sending, so the customer hears them in words instead of a bare
 * "failed", and reads the partner info again after a refusal to say which one
 * it was — the refusal itself reaches the browser without its reason.
 */

import {
  PARTNER_WITHDRAWAL_REQUISITES_MAX_LENGTH,
  type PartnerInfo,
  type PartnerWithdrawal,
} from "@/lib/api-client/partner";
import { standingBalanceHold, type PartnerBalanceHold } from "@/lib/partner-balance-hold";

/** One minor unit (0.01): the panel refuses zero and less, and nothing more. */
export const PARTNER_WITHDRAWAL_MIN_MINOR = 1;

/**
 * Whole units above this are not read as an amount. Far above any balance a
 * partner can hold (the column is a 32-bit integer of minor units), and small
 * enough that the arithmetic below stays exact.
 */
const MAX_WHOLE_DIGITS = 9;

export type WithdrawalAmountError = "required" | "invalid" | "tooSmall" | "tooLarge";

export type WithdrawalAmount =
  | { readonly ok: true; readonly minor: number }
  | { readonly ok: false; readonly error: WithdrawalAmountError };

/**
 * The typed amount in minor units. Whole units with up to two decimals, a dot
 * or a comma between them, spaces anywhere (a pasted «1 500,50» is fine). Done
 * on the digits, never through a float, so «0.29» is 29 and not 28.999….
 */
export function parseWithdrawalAmount(text: string, balanceMinor: number): WithdrawalAmount {
  const compact = text.replace(/\s/g, "");
  if (compact.length === 0) return { ok: false, error: "required" };
  const match = /^(\d+)(?:[.,](\d{0,2}))?$/.exec(compact);
  if (match === null) return { ok: false, error: "invalid" };
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  if (whole.length > MAX_WHOLE_DIGITS) return { ok: false, error: "tooLarge" };
  const cents = (match[2] ?? "").padEnd(2, "0");
  const minor = Number(whole) * 100 + Number(cents);
  if (minor < PARTNER_WITHDRAWAL_MIN_MINOR) return { ok: false, error: "tooSmall" };
  if (minor > balanceMinor) return { ok: false, error: "tooLarge" };
  return { ok: true, minor };
}

export type WithdrawalRequisites =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: "required" | "tooLong" };

/** The requisites as they will be sent: trimmed, not empty, not past the cap. */
export function checkWithdrawalRequisites(text: string): WithdrawalRequisites {
  const value = text.trim();
  if (value.length === 0) return { ok: false, error: "required" };
  if (value.length > PARTNER_WITHDRAWAL_REQUISITES_MAX_LENGTH) return { ok: false, error: "tooLong" };
  return { ok: true, value };
}

/**
 * Why no withdrawal can be asked for right now, or `null` when one can. The
 * hold comes first because it is the one that ends by itself, on a date.
 */
export type WithdrawalBlock =
  | { readonly kind: "hold"; readonly hold: PartnerBalanceHold }
  | { readonly kind: "invitedOnly" }
  | { readonly kind: "inactive" }
  | { readonly kind: "empty" };

type PartnerInfoView = Pick<PartnerInfo, "balance" | "isActive" | "programAvailable" | "balanceHold">;

export function withdrawalBlock(
  info: Partial<PartnerInfoView> | null | undefined,
  now: number = Date.now(),
): WithdrawalBlock | null {
  const hold = standingBalanceHold(info?.balanceHold, now);
  if (hold !== null) return { kind: "hold", hold };
  // `false` only: an older panel that does not send the flag is not a refusal.
  if (info?.programAvailable === false) return { kind: "invitedOnly" };
  if (info?.isActive === false) return { kind: "inactive" };
  const balance = info?.balance;
  if (typeof balance !== "number" || !Number.isFinite(balance) || balance < PARTNER_WITHDRAWAL_MIN_MINOR) {
    return { kind: "empty" };
  }
  return null;
}

/** What to tell the customer after the panel said no without saying why. */
export type WithdrawalRefusal =
  | { readonly kind: "hold"; readonly hold: PartnerBalanceHold }
  | { readonly kind: "invitedOnly" }
  | { readonly kind: "inactive" }
  | { readonly kind: "insufficient"; readonly balanceMinor: number }
  | { readonly kind: "notPartner" }
  | { readonly kind: "failed" };

/**
 * The refusal, from the partner info read AFTER it, in the order the panel
 * checks: who may take part, the hold, the partner switch, the balance. When
 * none of them explains it — or the info could not be read (the cabinet answers
 * `null` for "not a partner" and for "the panel failed" alike) — it is `failed`,
 * and the customer is told to look at the list before trying again.
 */
export function explainWithdrawalRefusal(
  fresh: Partial<PartnerInfoView> | null | undefined,
  amountMinor: number,
  now: number = Date.now(),
): WithdrawalRefusal {
  if (fresh === null || fresh === undefined) return { kind: "failed" };
  if (fresh.programAvailable === false) return { kind: "invitedOnly" };
  const hold = standingBalanceHold(fresh.balanceHold, now);
  if (hold !== null) return { kind: "hold", hold };
  if (fresh.isActive === false) return { kind: "inactive" };
  if (typeof fresh.balance === "number" && fresh.balance < amountMinor) {
    return { kind: "insufficient", balanceMinor: Math.max(0, fresh.balance) };
  }
  return { kind: "failed" };
}

/**
 * A request that did get created although the answer never said so — a
 * dropped connection, a timeout between the cabinet and the panel. The panel
 * debits first and answers after, so a failed call is not proof that nothing
 * happened, and a second tap would take the money twice. A PENDING request
 * that was not on the list before the tap, with exactly what was asked for, is
 * that request.
 */
export function findRequestCreatedAnyway(
  before: ReadonlySet<string> | null,
  after: readonly PartnerWithdrawal[],
  asked: { readonly amount: number; readonly method: string; readonly requisites: string },
): PartnerWithdrawal | null {
  if (before === null) return null;
  return (
    after.find(
      (row) =>
        !before.has(row.id) &&
        row.status === "PENDING" &&
        row.amount === asked.amount &&
        row.method === asked.method &&
        row.requisites === asked.requisites,
    ) ?? null
  );
}

const CURRENCY_SIGNS: Readonly<Record<string, string>> = {
  RUB: "₽",
  USD: "$",
  EUR: "€",
};

/**
 * Minor units for a sentence: «1500.50 ₽». The same shape the partner page
 * gives the balance (two decimals, the sign after), in the balance's own
 * currency; `null` is the page's own default, roubles.
 */
export function formatPartnerMoney(minor: number, currency: string | null | undefined): string {
  const sign = currency ? (CURRENCY_SIGNS[currency] ?? currency) : "₽";
  return `${(minor / 100).toFixed(2)} ${sign}`;
}

/** The amount as the input shows it when «Весь баланс» fills it in. */
export function formatAmountForInput(minor: number): string {
  return (minor / 100).toFixed(2);
}
