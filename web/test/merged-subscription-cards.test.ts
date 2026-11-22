import { describe, expect, it } from "vitest";

import type { Subscription } from "@/types/api";

import { subscriptionsShowingOneCard } from "@/features/dashboard/merged-subscription-cards";

function subscription(overrides: Partial<Subscription> & { id: string }): Subscription {
  return {
    userRemnaId: null,
    status: "ACTIVE",
    isTrial: false,
    trafficLimit: 50,
    plan: { id: "plan-limited", name: "Limited", type: "BOTH", icon: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Subscription;
}

describe("subscriptionsShowingOneCard", () => {
  it("keeps only the card the app shows and drops the other bundle members", () => {
    const limited = subscription({
      id: "sub-limited",
      merge: { bundleId: "bundle-1", bundleName: "Объеденёнка", visiblePlanId: "plan-limited" },
    });
    const unlimited = subscription({
      id: "sub-unlimited",
      trafficLimit: null,
      plan: { id: "plan-unlimited", name: "Unlimited", type: "UNLIMITED", icon: null },
      merge: { bundleId: "bundle-1", bundleName: "Объеденёнка", visiblePlanId: "plan-limited" },
    });

    expect(subscriptionsShowingOneCard([limited, unlimited]).map((s) => s.id)).toEqual([
      "sub-limited",
    ]);
  });

  it("keeps a lone subscription of a bundle untouched", () => {
    const lone = subscription({
      id: "sub-only-unlimited",
      trafficLimit: null,
      merge: { bundleId: "bundle-1", bundleName: "Объеденёнка", visiblePlanId: "plan-limited" },
    });

    expect(subscriptionsShowingOneCard([lone]).map((s) => s.id)).toEqual(["sub-only-unlimited"]);
  });

  it("leaves subscriptions without a merge group alone, in their original order", () => {
    const plain = subscription({ id: "sub-plain" });
    const merged = subscription({
      id: "sub-visible",
      merge: { bundleId: "bundle-1", bundleName: "Объеденёнка", visiblePlanId: "plan-limited" },
    });
    const sibling = subscription({
      id: "sub-sibling",
      trafficLimit: null,
      plan: { id: "plan-unlimited", name: "Unlimited", type: "UNLIMITED", icon: null },
      merge: { bundleId: "bundle-1", bundleName: "Объеденёнка", visiblePlanId: "plan-limited" },
    });

    expect(subscriptionsShowingOneCard([plain, merged, sibling]).map((s) => s.id)).toEqual([
      "sub-plain",
      "sub-visible",
    ]);
  });

  it("falls back to the first limited member when the app names none", () => {
    const unlimited = subscription({
      id: "sub-unlimited",
      trafficLimit: null,
      plan: { id: "plan-unlimited", name: "Unlimited", type: "UNLIMITED", icon: null },
      merge: { bundleId: "bundle-1", bundleName: "Объеденёнка", visiblePlanId: null },
    });
    const limited = subscription({
      id: "sub-limited",
      merge: { bundleId: "bundle-1", bundleName: "Объеденёнка", visiblePlanId: null },
    });

    expect(subscriptionsShowingOneCard([unlimited, limited]).map((s) => s.id)).toEqual([
      "sub-limited",
    ]);
  });
});
