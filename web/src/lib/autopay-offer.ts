/**
 * When the payment step offers a gateway's «для автоматического списания».
 *
 * ЮKassa saves a method and the panel charges it later, any sum at any time, so
 * its option is offered whenever the panel says the gateway may (`autopay`).
 *
 * On Platega, RollyPay and Antilopay the PROVIDER runs the subscription: it repeats the
 * first charge's sum every period, on its own schedule. So the option is
 * offered only for a purchase it can repeat exactly — the panel's
 * `resolveProviderSubscriptionTerms` (rezeis `provider-subscription-terms.util.ts`)
 * refuses everything else with `AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE`, and this
 * keeps the buyer from choosing what would only be refused:
 *   - roubles without kopecks (Platega takes whole roubles; RollyPay is held
 *     to the same rule);
 *   - a term that is one of the provider's periods: on Platega 1–31 days,
 *     1–12 months of 30 days, 1–3 years of 365 days; on RollyPay 30, 90, 180
 *     or 365 days; on Antilopay 7, 30, 90 or 365 days;
 *   - no one-time promo discount (`discountSource: "PURCHASE"`), which would be
 *     charged again every period; a personal discount is permanent and may be;
 *   - a new purchase, a renewal, or a plan change — «Сменить тариф», up or
 *     down, and what buying beside a trial is (`lib/trial-conversion.ts`): an
 *     UPGRADE priced like a new purchase, the plan's full price with its term
 *     from payment, so every later charge renews what the first one bought.
 *     Never a trial plan. A panel older than 15.10.2026 refuses it on a paid
 *     plan's change (reason `PURCHASE_TYPE`), and the page says so.
 * The refusal stays the authority: this is the same rule written twice, and a
 * panel that changes it answers with the code, which the pages handle. RollyPay
 * also needs a tariff the operator named for that sum and period, which only
 * the panel can see; its refusal is the same code.
 */
import type { PlanPrice } from "@/types/api";

/** The panel's `PROVIDER_SUBSCRIPTION_GATEWAY_TYPES`. */
export const PROVIDER_SUBSCRIPTION_GATEWAYS: ReadonlySet<string> = new Set(["PLATEGA", "ROLLYPAY", "ANTILOPAY"]);

/** RollyPay's fixed tariffs: month, quarter, half a year and a year, in days. */
const ROLLYPAY_PERIOD_DAYS: ReadonlySet<number> = new Set([30, 90, 180, 365]);

/** Antilopay's periods: a week, a month, a quarter and a year, in days. */
const ANTILOPAY_PERIOD_DAYS: ReadonlySet<number> = new Set([7, 30, 90, 365]);

/**
 * How a payer signs up for automatic charging where the gateway offers two
 * ways: Antilopay repeats a charge on a card or over SBP, and the two are
 * different kinds of recurrent payment, so the payer says which BEFORE the
 * payment form opens. The panel takes it as `autopayMethod`.
 */
export type AutopayMethod = "CARD" | "SBP";

/** A gateway as the panel lists it, as far as «для автоматического списания» goes. */
export interface AutopayGateway {
  readonly type: string;
  /** The panel's per-gateway `autopay`: approved by the operator and built. */
  readonly autopay?: boolean;
  /**
   * Where the operator approves methods one by one (Antilopay: a card and SBP,
   * two switches), the panel lists the approved ones here and keeps `autopay`
   * false. Absent from a panel older than the list — and then Antilopay offers
   * no automatic charging at all, which is what such a panel supports. A
   * cabinet older than the list reads `autopay: false` and offers nothing too.
   */
  readonly autopayMethods?: readonly string[];
  /**
   * Antilopay only, and only for a customer who may still use it: the delay of
   * the first SBP charge (`lib/autopay-delay.ts`). Absent from a panel older
   * than the delay, and then the consent says the charge is made now.
   */
  readonly autopayDelay?: unknown;
}

/**
 * The options a gateway's «для автоматического списания» comes in: one (null),
 * or one per method the operator approved and the payer chooses between.
 */
export function autopayOptions(gateway: Pick<AutopayGateway, "type" | "autopayMethods">): readonly (AutopayMethod | null)[] {
  if (gateway.type !== "ANTILOPAY") return [null];
  const approved = Array.isArray(gateway.autopayMethods) ? gateway.autopayMethods : [];
  return (["CARD", "SBP"] as const).filter((method) => approved.includes(method));
}

/** Whether the operator approved automatic charging on this gateway, by any method it has. */
export function approvesAutopay(gateway: AutopayGateway): boolean {
  return gateway.type === "ANTILOPAY" ? autopayOptions(gateway).length > 0 : gateway.autopay === true;
}

/** The caption under an autopay option: «для автоматического списания», with the method where there is one. */
export function autopayCaptionKey(method: AutopayMethod | null | undefined): string {
  if (method === "CARD") return "purchase.gateway.autopayCaptionCard";
  if (method === "SBP") return "purchase.gateway.autopayCaptionSbp";
  return "purchase.gateway.autopayCaption";
}

/** What the quote step tells the payer about the automatic charging they chose. */
export function autopayHintKey(gatewayType: string | null | undefined, method: AutopayMethod | null | undefined): string {
  if (!isProviderSubscriptionGateway(gatewayType)) return "purchase.quote.autopayHint";
  return method === "CARD" ? "purchase.quote.autopayProviderCardHint" : "purchase.quote.autopayProviderHint";
}

export function isProviderSubscriptionGateway(gatewayType: string | null | undefined): boolean {
  return typeof gatewayType === "string" && PROVIDER_SUBSCRIPTION_GATEWAYS.has(gatewayType);
}

/** Whether a term of `days` is one of the gateway's periods. */
export function isProviderPeriod(gatewayType: string, days: number): boolean {
  if (!Number.isInteger(days) || days <= 0) return false;
  if (gatewayType === "ROLLYPAY") return ROLLYPAY_PERIOD_DAYS.has(days);
  if (gatewayType === "ANTILOPAY") return ANTILOPAY_PERIOD_DAYS.has(days);
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
  /** The methods approved on a gateway that approves them one by one (Antilopay). */
  readonly autopayMethods?: readonly string[] | undefined;
  /** What is being bought; null when the page does not know it yet. */
  readonly purchase: {
    readonly durationDays: number;
    readonly price: Pick<PlanPrice, "currency" | "price" | "discountSource"> | undefined;
    readonly isTrial: boolean;
  } | null;
}): boolean {
  if (!approvesAutopay({ type: input.gatewayType, autopay: input.autopay, autopayMethods: input.autopayMethods })) return false;
  if (!isProviderSubscriptionGateway(input.gatewayType)) return true;
  const purchase = input.purchase;
  if (purchase === null || purchase.isTrial) return false;
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
 * The panel's reason for that refusal when the delay of the first SBP charge the
 * customer was shown is not the one it gives now: the operator changed it, or
 * the customer used it in another tab. Nothing was created and nobody was
 * charged; the list of gateways is read again and the customer chooses anew.
 */
export const AUTOPAY_DELAY_CHANGED_REASON = "DELAY_CHANGED";

export function isAutopayDelayChangedRefusal(err: unknown): boolean {
  if (!isAutopayNotAvailableRefusal(err)) return false;
  const data = (err as { response?: { data?: { reason?: unknown } } }).response?.data;
  return data?.reason === AUTOPAY_DELAY_CHANGED_REASON;
}

/**
 * The panel's reason for that refusal when the approval is off — the operator's
 * switch, or a gateway that refused the repeat charge (Antilopay's errors 29 and
 * 30). Nothing is wrong with THIS purchase: automatic charging is unavailable
 * for now, and the ordinary payment is the way on.
 */
export const AUTOPAY_NOT_APPROVED_REASON = "NOT_APPROVED";

export function isAutopayNotApprovedRefusal(err: unknown): boolean {
  if (!isAutopayNotAvailableRefusal(err)) return false;
  const data = (err as { response?: { data?: { reason?: unknown } } }).response?.data;
  return data?.reason === AUTOPAY_NOT_APPROVED_REASON;
}

/**
 * What the purchase and the renewal pages say for an autopay refusal: the
 * message key and its values. A sign-up already under way has its own, and so
 * has an approval that is off («сейчас недоступно», not «для этой покупки»);
 * every other reason, and a refusal that names none (an older panel), keeps the
 * ordinary-payment text.
 */
export function autopayRefusalMessage(err: unknown): {
  readonly key: string;
  readonly values?: Readonly<Record<string, number>>;
} {
  if (isAutopaySignUpPendingRefusal(err)) {
    return { key: "purchase.checkout.autopaySignUpPending", values: { minutes: AUTOPAY_SIGN_UP_HOLD_MINUTES } };
  }
  if (isAutopayNotApprovedRefusal(err)) return { key: "purchase.checkout.autopayUnavailableNow" };
  if (isAutopayDelayChangedRefusal(err)) return { key: "purchase.checkout.autopayDelayChanged" };
  return { key: "purchase.checkout.autopayNotAvailable" };
}
