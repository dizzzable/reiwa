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
  policyCanRenew: boolean | undefined,
): boolean {
  return (
    subscription !== null &&
    RENEWABLE_STATUSES.has(subscription.status) &&
    // Fail closed for legacy/incomplete payloads. Renewing a subscription is
    // safe only when the immutable marker explicitly says it is not a trial.
    subscription.isTrial === false &&
    policyCanRenew === true &&
    !restricted
  );
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
