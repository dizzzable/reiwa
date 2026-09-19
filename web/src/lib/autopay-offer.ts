/**
 * When the payment step offers a gateway's «для автоматического списания».
 *
 * ЮKassa saves a method and the panel charges it later, any sum at any time, so
 * its option is offered whenever the panel says the gateway may (`autopay`).
 *
 * On Platega the PROVIDER runs the subscription: it repeats the first charge's
 * sum every period, on its own schedule. So the option is offered only for a
 * purchase it can repeat exactly — the panel's `resolveProviderSubscriptionTerms`
 * (rezeis `provider-subscription-terms.util.ts`) refuses everything else with
 * `AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE`, and this keeps the buyer from choosing
 * what would only be refused:
 *   - roubles without kopecks (Platega takes whole roubles);
 *   - a term that is one of its periods: 1–31 days, 1–12 months of 30 days,
 *     1–3 years of 365 days;
 *   - no one-time promo discount (`discountSource: "PURCHASE"`), which would be
 *     charged again every period; a personal discount is permanent and may be;
 *   - a new purchase or a renewal, never a trial.
 * The refusal stays the authority: this is the same rule written twice, and a
 * panel that changes it answers with the code, which the pages handle.
 */
import type { PlanPrice } from "@/types/api";

/** The panel's `PROVIDER_SUBSCRIPTION_GATEWAY_TYPES`. */
export const PROVIDER_SUBSCRIPTION_GATEWAYS: ReadonlySet<string> = new Set(["PLATEGA"]);

export function isProviderSubscriptionGateway(gatewayType: string | null | undefined): boolean {
  return typeof gatewayType === "string" && PROVIDER_SUBSCRIPTION_GATEWAYS.has(gatewayType);
}

/** Whether a term of `days` is one of Platega's periods. */
export function isProviderPeriod(days: number): boolean {
  if (!Number.isInteger(days) || days <= 0) return false;
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
  } | null;
}): boolean {
  if (input.autopay !== true) return false;
  if (!isProviderSubscriptionGateway(input.gatewayType)) return true;
  const purchase = input.purchase;
  if (purchase === null || purchase.isTrial) return false;
  return isProviderPeriod(purchase.durationDays) && isRepeatablePrice(purchase.price);
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
