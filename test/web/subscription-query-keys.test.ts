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

  it.each([
    "subscription.created",
    "subscription.deleted",
    "subscription.renewed",
    "subscription.expired",
    "subscription.upgraded",
  ])("maps %s to the canonical subscription list", (eventType) => {
    expect(userRealtimeQueryKeysByType[eventType]).toContain(subscriptionQueryKeys.all);
  });
});
