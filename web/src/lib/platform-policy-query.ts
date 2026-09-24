/**
 * The platform policy query every reader shares — `/api/v1/platform-policy`.
 *
 * A policy nobody could read is UNKNOWN, never the public one. The owner's
 * rule of 24.09.2026: the cabinet must not read a 503 from this route as
 * "open to everyone" (`PUBLIC`) or as any other permissive "off". The route
 * answers 503 only when the cabinet's API process has never known a policy —
 * nothing in memory, no copy in Redis — and the panel is down, so sign-in and
 * buying do not work then either; what must not happen is a gate quietly
 * opening (W8 report D4, CD1 §4).
 *
 * So: no data means unknown. Readers that gate something wait — they read
 * `data === undefined` as "loading" — and the query keeps asking on its own,
 * three seconds after the first failure, doubling to thirty. It asks as a
 * POLL rather than through React Query's retryer: the retryer does not fail on
 * a page whose visibility reads `hidden`, it parks, and a parked query cannot
 * be restarted (`lib/branding-provider.tsx` has the whole story). Once a
 * policy has been read, a later failure keeps it, as React Query does, and the
 * poll stops.
 *
 * Every reader uses these options, so the shared key behaves one way whoever
 * mounted first.
 */
// Types only: a number of suites mock `@tanstack/react-query` down to the few
// runtime exports the shell uses, and a runtime import here (`queryOptions`)
// would break every one of them for no behaviour of its own.
import type { Query, UseQueryOptions } from "@tanstack/react-query";

import { getPlatformPolicy } from "@/lib/api-client";
import type { PlatformPolicy } from "@/types/api";

export const PLATFORM_POLICY_QUERY_KEY = ["platform-policy"] as const;

/** The first ask again 3 s after a failure, doubling to 30 s. */
export const PLATFORM_POLICY_RETRY_FIRST_MS = 3_000;
export const PLATFORM_POLICY_RETRY_MAX_MS = 30_000;

/** How long to wait before asking again, after `failuresInARow` failures with nothing known. */
export function platformPolicyRetryDelay(failuresInARow: number): number {
  const doublings = Math.max(0, failuresInARow - 1);
  return Math.min(PLATFORM_POLICY_RETRY_FIRST_MS * 2 ** doublings, PLATFORM_POLICY_RETRY_MAX_MS);
}

/**
 * The poll's cadence: only while no policy was ever read and the last read
 * failed. `errorUpdateCount` counts exactly those failures — a success would
 * have set `data` and ended the poll.
 */
export function platformPolicyRefetchInterval(
  query: Pick<Query<PlatformPolicy, Error>, "state">,
): number | false {
  const { data, status, errorUpdateCount } = query.state;
  return data === undefined && status === "error" ? platformPolicyRetryDelay(errorUpdateCount) : false;
}

export const platformPolicyQueryOptions: UseQueryOptions<
  PlatformPolicy,
  Error,
  PlatformPolicy,
  typeof PLATFORM_POLICY_QUERY_KEY
> = {
  queryKey: PLATFORM_POLICY_QUERY_KEY,
  queryFn: getPlatformPolicy,
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  retry: false,
  refetchOnWindowFocus: false,
  refetchInterval: platformPolicyRefetchInterval,
  // The interval is `false` whenever a policy is known, so this only ever
  // applies to a cabinet that has none to go by.
  refetchIntervalInBackground: true,
};
