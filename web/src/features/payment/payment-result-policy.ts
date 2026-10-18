import type { AutopaySignUpStatus } from "@/types/api";

export type PaymentResultInput = {
  readonly status: "PENDING" | "COMPLETED" | "CANCELED" | "REFUNDED" | "FAILED";
  readonly checkoutUrl: string | null;
  readonly errorCode?: string | null;
  /** The panel's word on an Antilopay SBP sign-up whose plan comes with its first charge. */
  readonly autopaySignUp?: AutopaySignUpStatus | null;
};

/**
 * `awaiting-charge`: an SBP subscription the payer confirmed in their bank, whose
 * first charge has not come yet. Since 18.10.2026 the plan comes with that
 * charge and only with it, so the checkout is neither paid nor failed: with a
 * delay it waits days (and the panel closes it meanwhile, which a CANCELED
 * status alone would read as a failure), without one it waits for the bank.
 * `charge-failed`: that charge did not come.
 */
export type PaymentResult = "processing" | "success" | "failed" | "unresolved" | "awaiting-charge" | "charge-failed";

/** Provider URL is optional: status is authoritative once the payment exists. */
export function resolvePaymentResult(input: PaymentResultInput): PaymentResult {
  if (input.errorCode === "PROVIDER_CHECKOUT_CREATION_UNRESOLVED") return "unresolved";
  if (input.status === "COMPLETED") return "success";
  if (input.autopaySignUp?.state === "FIRST_CHARGE_FAILED") return "charge-failed";
  if (input.autopaySignUp?.state === "AWAITING_FIRST_CHARGE") return "awaiting-charge";
  if (input.status === "FAILED" || input.status === "CANCELED" || input.status === "REFUNDED") {
    return "failed";
  }
  return "processing";
}

/**
 * How far off the first charge must be for the page to stop waiting for it: a
 * delayed first charge comes days later, and the page says when instead of
 * polling for a minute and calling it a timeout. One made at activation is
 * waited for, as any payment.
 */
export const FIRST_CHARGE_LATER_MS = 10 * 60 * 1000;

export function firstChargeIsLater(signUp: AutopaySignUpStatus | null | undefined, now: number): boolean {
  if (signUp?.firstChargeAt == null) return false;
  const at = Date.parse(signUp.firstChargeAt);
  return Number.isFinite(at) && at - now > FIRST_CHARGE_LATER_MS;
}
