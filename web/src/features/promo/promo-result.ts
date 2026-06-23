/**
 * Shared mapping from a promo activation result to i18n keys, so every promo
 * entry point (the dedicated /promo page, the settings sub-page, the checkout
 * inline input) renders the same reason-aware copy and never shows a false
 * "success"/"invalid".
 */
import type { PromoActivationResult } from "@/lib/api-client";

const REWARD_TYPES = new Set([
  "DURATION",
  "TRAFFIC",
  "DEVICES",
  "SUBSCRIPTION",
  "PERSONAL_DISCOUNT",
  "PURCHASE_DISCOUNT",
]);

const ERROR_CODES = new Set([
  "NOT_FOUND",
  "INACTIVE",
  "EXPIRED",
  "DEPLETED",
  "ALREADY_ACTIVATED",
  "NOT_AVAILABLE_FOR_USER",
  "PLAN_NOT_ELIGIBLE",
  "SUBSCRIPTION_NOT_FOUND",
  "SUBSCRIPTION_NOT_ACTIVE",
  "SUBSCRIPTION_FOREIGN",
  "NO_ELIGIBLE_SUBSCRIPTION",
  "REWARD_NOT_APPLICABLE",
  "INTERNAL_ERROR",
]);

/** i18n key for a successful activation, by reward type. */
export function promoSuccessKey(reward: PromoActivationResult["reward"]): string {
  const type = reward?.type ?? "";
  return REWARD_TYPES.has(type) ? `promo.successByType.${type}` : "promo.successByType.default";
}

/** i18n key for a rejected activation, by error code. */
export function promoErrorKey(errorCode: string | null | undefined): string {
  return errorCode && ERROR_CODES.has(errorCode)
    ? `promo.errors.${errorCode}`
    : "promo.errors.default";
}
