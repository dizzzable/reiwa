/**
 * Servers namespace — the places one subscription can reach.
 *
 * Read when the customer double-taps their subscription card. The BFF answers
 * an empty list rather than an error whenever the panel or Remnawave is
 * unreachable, so this resolves in every case a caller has to handle — the
 * screen is decoration over a subscription that works regardless.
 */
import { apiClient } from "./transport.js";

/** One server, exactly as the panel is willing to describe it. */
export interface SubscriberServer {
  readonly id: string;
  /** The host's name as the operator wrote it — flag included. */
  readonly name: string;
  readonly flag: string | null;
  /** ISO 3166-1 alpha-2, or a code with no single point on Earth (`EU`). */
  readonly countryCode: string | null;
  readonly status: "online" | "connecting" | "offline" | "unknown";
  /** Seconds the process has run. Not availability — see the panel's note. */
  readonly uptimeSeconds: number | null;
  // No `usersOnline`: the BFF stops it at the boundary. The panel uses the
  // count to pick the recommended server and nothing here ever displayed it.
}

export interface SubscriberServersResponse {
  readonly servers: readonly SubscriberServer[];
  /** Least busy server that is up, decided by the panel. */
  readonly recommendedServerId: string | null;
}

export const getSubscriptionServers = (
  subscriptionId: string,
): Promise<SubscriberServersResponse> =>
  apiClient
    .get<SubscriberServersResponse>(
      `/subscription/${encodeURIComponent(subscriptionId)}/servers`,
    )
    .then((r) => r.data);
