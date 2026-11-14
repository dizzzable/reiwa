import { describe, expect, it } from "vitest";

import type { Subscription } from "@/types/api";

import { mergedCardTrafficBySubscriptionId } from "@/features/dashboard/merged-subscription-traffic";

function subscription(overrides: Partial<Subscription> & { id: string }): Subscription {
  return {
    userRemnaId: null,
    status: "ACTIVE",
    isTrial: false,
    trafficLimit: 50,
    trafficUsed: 10,
    plan: { id: "plan-limited", name: "Limited", type: "BOTH", icon: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Subscription;
}

function mergedBundle(overrides: Partial<NonNullable<Subscription["merge"]>> = {}) {
  return {
    bundleId: "bundle-1",
    bundleName: "Объеденёнка",
    visiblePlanId: "plan-limited",
    ...overrides,
  };
}

describe("mergedCardTrafficBySubscriptionId", () => {
  it("marks the card unlimited when the bundle holds an unlimited plan", () => {
    const merge = mergedBundle();
    const limited = subscription({ id: "sub-limited", merge });
    const unlimited = subscription({
      id: "sub-unlimited",
      trafficLimit: null,
      trafficUsed: null,
      plan: { id: "plan-unlimited", name: "Безлимит", type: "UNLIMITED", icon: null },
      merge,
    });

    expect(mergedCardTrafficBySubscriptionId([limited, unlimited])).toEqual({
      "sub-limited": { hasUnlimited: true },
    });
  });

  it("adds nothing to a limited bundle's card (no second tariff line)", () => {
    const merge = mergedBundle();
    const limited = subscription({ id: "sub-limited", merge });
    const extra = subscription({
      id: "sub-extra",
      trafficUsed: 0.01,
      trafficLimit: 200,
      plan: { id: "plan-extra", name: "200 ГБ", type: "TRAFFIC", icon: null },
      merge,
    });

    expect(mergedCardTrafficBySubscriptionId([limited, extra])).toEqual({
      "sub-limited": { hasUnlimited: false },
    });
  });

  it("leaves a lone subscription and a DELETED sibling out", () => {
    const lone = subscription({ id: "solo", merge: mergedBundle() });
    const kept = subscription({ id: "kept" });
    const deleted = subscription({
      id: "gone",
      status: "DELETED",
      plan: { id: "plan-unlimited", name: "Безлимит", type: "UNLIMITED", icon: null },
      merge: mergedBundle(),
    });

    expect(mergedCardTrafficBySubscriptionId([lone])).toEqual({});
    expect(mergedCardTrafficBySubscriptionId([kept, deleted])).toEqual({});
  });
});
