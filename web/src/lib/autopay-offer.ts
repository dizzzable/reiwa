/**
 * When the payment step offers a gateway's «для автоматического списания».
 *
 * ЮKassa saves a method and the panel charges it later, any sum at any time, so
 * its option is offered whenever the panel says the gateway may (`autopay`).
 *
 * On Platega and RollyPay the PROVIDER runs the subscription: it repeats the
 * first charge's sum every period, on its own schedule. So the option is
 * offered only for a purchase it can repeat exactly — the panel's
 * `resolveProviderSubscriptionTerms` (rezeis `provider-subscription-terms.util.ts`)
 * refuses everything else with `AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE`, and this
 * keeps the buyer from choosing what would only be refused:
 *   - roubles without kopecks (Platega takes whole roubles; RollyPay is held
 *     to the same rule);
 *   - a term that is one of the provider's periods: on Platega 1–31 days,
 *     1–12 months of 30 days, 1–3 years of 365 days; on RollyPay 30, 90, 180
 *     or 365 days;
 *   - no one-time promo discount (`discountSource: "PURCHASE"`), which would be
 *     charged again every period; a personal discount is permanent and may be;
 *   - a new purchase, a renewal, or the conversion of the buyer's trial — what
 *     buying beside a trial is (`lib/trial-conversion.ts`): an UPGRADE priced
 *     like a new purchase, the plan's full price with its term from payment,
 *     so every later charge renews what the first one bought. Never a trial
 *     plan, and never a change of a plan somebody already pays for: the panel
 *     refuses a provider subscription on any other UPGRADE.
 * The refusal stays the authority: this is the same rule written twice, and a
 * panel that changes it answers with the code, which the pages handle. RollyPay
 * also needs a tariff the operator named for that sum and period, which only
 * the panel can see; its refusal is the same code.
 */
import type { PlanPrice } from "@/types/api";

/** The panel's `PROVIDER_SUBSCRIPTION_GATEWAY_TYPES`. */
export const PROVIDER_SUBSCRIPTION_GATEWAYS: ReadonlySet<string> = new Set(["PLATEGA", "ROLLYPAY"]);

/** RollyPay's fixed tariffs: month, quarter, half a year and a year, in days. */
const ROLLYPAY_PERIOD_DAYS: ReadonlySet<number> = new Set([30, 90, 180, 365]);

export function isProviderSubscriptionGateway(gatewayType: string | null | undefined): boolean {
  return typeof gatewayType === "string" && PROVIDER_SUBSCRIPTION_GATEWAYS.has(gatewayType);
}

/** Whether a term of `days` is one of the gateway's periods. */
export function isProviderPeriod(gatewayType: string, days: number): boolean {
  if (!Number.isInteger(days) || days <= 0) return false;
  if (gatewayType === "ROLLYPAY") return ROLLYPAY_PERIOD_DAYS.has(days);
  return days <= 31 || (days % 30 === 0 && days <= 360) || (days % 365 === 0 && days <= 1095);
}

/** A price the provider can charge again as it is: roubles, no kopecks, no one-time promo. */
export function isRepeatablePrice(price: Pick<PlanPrice, "currency" | "price" | "discountSource"> | undefined): boolean {
  if (price === undefined) return false;
  if (price.currency !== "RUB") return false;
  if (price.discountSource === "PURCHASE") return false;
  return /^\d+(\.0+)?$/.test(String(price.price).trim()) && Number(price.price) > 0;
}

export function offersAutopay(input: {
  readonly gatewayType: string;
  /** The panel's per-gateway `autopay`: approved by the operator and built. */
  readonly autopay: boolean | undefined;
  /** What is being bought; null when the page does not know it yet. */
  readonly purchase: {
    readonly durationDays: number;
    readonly price: Pick<PlanPrice, "currency" | "price" | "discountSource"> | undefined;
    readonly isTrial: boolean;
    /** An UPGRADE rather than a subscription created or renewed. */
    readonly planChange?: boolean;
    /** The UPGRADE converts the buyer's trial (`lib/trial-conversion.ts`). */
    readonly convertsTrial?: boolean;
  } | null;
}): boolean {
  if (input.autopay !== true) return false;
  if (!isProviderSubscriptionGateway(input.gatewayType)) return true;
  const purchase = input.purchase;
  if (purchase === null || purchase.isTrial) return false;
  if (purchase.planChange === true && purchase.convertsTrial !== true) return false;
  return isProviderPeriod(input.gatewayType, purchase.durationDays) && isRepeatablePrice(purchase.price);
}

/**
 * A renewal onto a plan other than the one the subscription is on — an archived
 * plan's replacement, or a plan chosen at renewal. The panel refuses a provider
 * subscription on one (`renewsOntoAnotherPlan`, reason `PLAN_CHANGE`): the
 * subscription keeps its old plan until the new plan's term begins, and the
 * provider's charges would be cancelled as "moved to another plan". So the
 * renewal page does not offer it. Unknown on either side is not a change: a
 * subscription whose snapshot names no plan has nothing to compare, for the
 * panel too.
 */
export function renewsOntoAnotherPlan(
  currentPlanId: string | number | null | undefined,
  renewalPlanId: string | number | null | undefined,
): boolean {
  if (currentPlanId === null || currentPlanId === undefined || String(currentPlanId).length === 0) return false;
  if (renewalPlanId === null || renewalPlanId === undefined || String(renewalPlanId).length === 0) return false;
  return String(currentPlanId) !== String(renewalPlanId);
}

/** The panel's code for «для автоматического списания» refused on this purchase. */
export const AUTOPAY_NOT_AVAILABLE_CODE = "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE";

export function isAutopayNotAvailableRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === AUTOPAY_NOT_AVAILABLE_CODE
  );
}

/**
 * The panel's reason for that refusal when another sign-up converting the same
 * trial still waits for the bank. A second one would convert the trial again,
 * and so would the ordinary payment beside it — so the page says to finish the
 * first, or to wait for it to lapse, and never offers the ordinary payment.
 */
export const AUTOPAY_SIGN_UP_PENDING_REASON = "PENDING_SIGN_UP";

/**
 * How long a pending sign-up holds, in minutes: the panel's checkout lifetime
 * (`CHECKOUT_LIFETIME_MS` in rezeis), after which the provider lets the unconfirmed
 * request lapse and the panel stops counting it.
 */
export const AUTOPAY_SIGN_UP_HOLD_MINUTES = 30;

/**
 * The refusal above, with the reason {@link AUTOPAY_SIGN_UP_PENDING_REASON}. Read
 * from the error body's `reason`; a response that carries none is the generic
 * refusal.
 */
export function isAutopaySignUpPendingRefusal(err: unknown): boolean {
  if (!isAutopayNotAvailableRefusal(err)) return false;
  const data = (err as { response?: { data?: { reason?: unknown } } }).response?.data;
  return data?.reason === AUTOPAY_SIGN_UP_PENDING_REASON;
}

/**
 * What the purchase page says for an autopay refusal: the message key and its
 * values. A sign-up already under way has its own; every other reason, and a
 * refusal that names none (an older panel), keeps the ordinary-payment text.
 */
export function autopayRefusalMessage(err: unknown): {
  readonly key: string;
  readonly values?: Readonly<Record<string, number>>;
} {
  return isAutopaySignUpPendingRefusal(err)
    ? { key: "purchase.checkout.autopaySignUpPending", values: { minutes: AUTOPAY_SIGN_UP_HOLD_MINUTES } }
    : { key: "purchase.checkout.autopayNotAvailable" };
}
