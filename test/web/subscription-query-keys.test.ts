import { describe, expect, it } from "vitest";

import { subscriptionQueryKeys } from "../../web/src/lib/subscription-query-keys.js";
import { userRealtimeQueryKeysByType } from "../../web/src/lib/user-realtime-query-keys.js";

describe("subscription query keys", () => {
  it("exposes the dashboard list key as the single canonical all-subscriptions key", () => {
    expect(subscriptionQueryKeys.all).toEqual(["subscriptions", "all"]);
  });

  it("keeps the plural root as a prefix for broad invalidation", () => {
    expect(subscriptionQueryKeys.all.slice(0, subscriptionQueryKeys.root.length)).toEqual(
      subscriptionQueryKeys.root,
    );
  });

  it("isolates the portfolio policy from every selected subscription policy", () => {
    expect(subscriptionQueryKeys.actionPolicy()).toEqual([
      "action-policy",
      "portfolio",
    ]);
    expect(subscriptionQueryKeys.actionPolicy("subscription-1")).toEqual([
      "action-policy",
      "subscription-1",
    ]);
    expect(subscriptionQueryKeys.actionPolicy("subscription-2")).not.toEqual(
      subscriptionQueryKeys.actionPolicy("subscription-1"),
    );
    expect(
      subscriptionQueryKeys
        .actionPolicy("subscription-1")
        .slice(0, subscriptionQueryKeys.actionPolicyRoot.length),
    ).toEqual(subscriptionQueryKeys.actionPolicyRoot);
  });

  it.each([
    "subscription.created",
    "subscription.deleted",
    "subscription.renewed",
    "subscription.expired",
    "subscription.upgraded",
  ])("maps %s to the canonical subscription list", (eventType) => {
    expect(userRealtimeQueryKeysByType[eventType]).toContain(subscriptionQueryKeys.all);
  });

  it.each([
    "subscription.created",
    "subscription.deleted",
    "subscription.renewed",
    "subscription.expired",
    "subscription.upgraded",
    "subscription.trial_granted",
    "payment.completed",
  ])("invalidates scoped action policies after %s", (eventType) => {
    expect(userRealtimeQueryKeysByType[eventType]).toContain(
      subscriptionQueryKeys.actionPolicyRoot,
    );
  });

});
