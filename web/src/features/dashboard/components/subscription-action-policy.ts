import type { Subscription } from "@/types/api";

const RENEWABLE_STATUSES = new Set(["ACTIVE", "LIMITED", "EXPIRED"]);

/**
 * Trial subscriptions are one-time activations. This is deliberately based on
 * the immutable subscription marker rather than `trialFree`: a paid trial must
 * be upgraded too, otherwise RENEW would bypass the plan's activation limit.
 */
export function canRenewSubscription(
  subscription: Subscription | null,
  restricted: boolean,
): boolean {
  return (
    subscription !== null &&
    RENEWABLE_STATUSES.has(subscription.status) &&
    subscription.isTrial !== true &&
    !restricted
  );
}
