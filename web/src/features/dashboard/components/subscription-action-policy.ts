import type { Subscription } from "@/types/api";
import { isLifetimeSubscription } from "@/features/renewal/lifetime-renewal";

const RENEWABLE_STATUSES = new Set(["ACTIVE", "LIMITED", "EXPIRED"]);

/**
 * Trial subscriptions are one-time activations. This is deliberately based on
 * the immutable subscription marker rather than `trialFree`: a paid trial must
 * be upgraded too, otherwise RENEW would bypass the plan's activation limit.
 *
 * A subscription with no end date is never renewed either
 * (`features/renewal/lifetime-renewal.ts`): the panel refuses it, so the
 * button must not offer it even when an older panel's policy still says RENEW.
 */
export function canRenewSubscription(
  subscription: Subscription | null,
  restricted: boolean,
  policyCanRenew: boolean | undefined,
): boolean {
  return (
    subscription !== null &&
    RENEWABLE_STATUSES.has(subscription.status) &&
    // Fail closed for legacy/incomplete payloads. Renewing a subscription is
    // safe only when the immutable marker explicitly says it is not a trial.
    subscription.isTrial === false &&
    !isLifetimeSubscription(subscription) &&
    policyCanRenew === true &&
    !restricted
  );
}

/**
 * Why a subscription's «Продлить» is not offered, as the note under it says —
 * or `null` when there is nothing to explain. A trial is upgraded, not renewed;
 * a subscription with no end date has nothing to renew, which the panel says
 * through its policy (`policyLifetime`) or the row says by having no date.
 */
export function renewalReasonKey(
  subscription: Subscription | null,
  policyLifetime: boolean | undefined,
): "renewal.reason.trial" | "renewal.reason.lifetime" | null {
  if (subscription === null) return null;
  if (subscription.isTrial === true) return "renewal.reason.trial";
  if (policyLifetime === true || isLifetimeSubscription(subscription)) return "renewal.reason.lifetime";
  return null;
}

/**
 * Re-check the complete renewal policy at invocation time. The native
 * `disabled` attribute prevents pointer/keyboard activation, while this guard
 * also protects against programmatic clicks and a stale render during a
 * carousel policy transition.
 */
export function invokeRenewSubscriptionAction(input: {
  readonly subscription: Subscription | null;
  readonly restricted: boolean;
  readonly policyCanRenew: boolean | undefined;
  readonly onRenew: () => void;
}): boolean {
  if (
    !canRenewSubscription(
      input.subscription,
      input.restricted,
      input.policyCanRenew,
    )
  ) {
    return false;
  }

  input.onRenew();
  return true;
}
