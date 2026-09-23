/**
 * A purchase beside a trial converts the trial.
 *
 * While the subscriber holds a trial, «Купить» creates no second subscription:
 * the plan they pay for is an UPGRADE of the trial — the same subscription and
 * the same link, the trial flag cleared, the term starting at payment. With
 * multi-subscription on the purchase used to be ADDITIONAL, and the subscriber
 * came away holding the trial AND a second subscription with a second link to
 * set up again. The panel now refuses that purchase too
 * (`TRIAL_UPGRADE_REQUIRED`, rezeis `isConvertibleTrial`); this is how the
 * cabinet avoids meeting the refusal.
 *
 * Which trial: one an upgrade may move — ACTIVE, LIMITED or EXPIRED, the set
 * the upgrade page offers. DISABLED is an operator's freeze, which the upgrade
 * would lift; DELETED is never listed. A live trial is preferred to an expired
 * one. The panel's rule is the same set, so the two agree on WHETHER a trial
 * blocks a new subscription; which one is converted is decided here.
 */
import { useQuery } from "@tanstack/react-query";

import { getAllSubscriptions } from "@/lib/api-client";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import type { Subscription } from "@/types/api";

export function trialToConvert(
  subscriptions: readonly Subscription[] | undefined,
): Subscription | null {
  const trials = (subscriptions ?? []).filter((subscription) => subscription.isTrial === true);
  return (
    trials.find((trial) => trial.status === "ACTIVE" || trial.status === "LIMITED") ??
    trials.find((trial) => trial.status === "EXPIRED") ??
    null
  );
}

/**
 * The trial this subscriber's purchase converts, from the subscription list the
 * dashboard holds (same key, so usually already in the cache).
 *
 * `settled` is false until the list has been read or has failed: until then a
 * purchase does not know what it is and must not be priced or paid. A list that
 * failed reads as "no trial" — the purchase goes on as a new subscription, and
 * a panel that sees a trial refuses it with the code
 * {@link isTrialConversionRequiredRefusal} recognises.
 */
export function useTrialToConvert(): { readonly trial: Subscription | null; readonly settled: boolean } {
  const { data, isFetched, isError } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  return {
    trial: trialToConvert(data?.subscriptions),
    settled: isFetched || isError,
  };
}

/** The panel's code for a new subscription refused because the buyer holds a trial. */
export const TRIAL_UPGRADE_REQUIRED_CODE = "TRIAL_UPGRADE_REQUIRED";

export function isTrialConversionRequiredRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === TRIAL_UPGRADE_REQUIRED_CODE
  );
}
