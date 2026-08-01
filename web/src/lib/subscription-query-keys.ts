const subscriptionQueryRoot = ["subscriptions"] as const;
const actionPolicyQueryRoot = ["action-policy"] as const;

/**
 * Canonical React Query keys for subscription data.
 *
 * `root` intentionally remains a prefix of `all`, so callers can choose
 * between invalidating every plural subscription query and only the complete
 * subscription list. The singular key is retained for the legacy detail view.
 */
export const subscriptionQueryKeys = {
  root: subscriptionQueryRoot,
  all: [...subscriptionQueryRoot, "all"] as const,
  detail: ["subscription"] as const,
  actionPolicyRoot: actionPolicyQueryRoot,
  /**
   * `portfolio` is the capacity/global policy. A subscription id produces a
   * separate cache entry so switching carousel cards can never reuse another
   * subscription's RENEW decision.
   */
  actionPolicy: (subscriptionId?: string | null) =>
    [...actionPolicyQueryRoot, subscriptionId ?? "portfolio"] as const,
} as const;
