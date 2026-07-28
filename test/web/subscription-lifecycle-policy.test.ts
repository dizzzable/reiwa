import { describe, expect, it } from "vitest";

import {
  buildSubscriptionCarouselItems,
  hasAllReadySubscriptionTargets,
  isRemnawaveSubscriptionReady,
  provisioningCarouselItemKey,
  retainCarouselItemDuringDeletion,
  resolveActiveCarouselItemKeyDuringDeletion,
  resolveTrialProvisioningPaymentStatus,
  resolveActiveCarouselItemKey,
  selectCarouselItemAfterRemoval,
  selectNewestUnfocusedProvisioningKey,
  subscriptionCarouselItemKey,
} from "../../web/src/features/dashboard/subscription-lifecycle-policy.js";
import type { SubscriptionProvisioningReceipt } from "../../web/src/lib/subscription-provisioning-receipt.js";
import type { PaymentStatus, Subscription } from "../../web/src/types/api.js";

function subscription(
  id: string,
  ready = true,
  isTrial = false,
): Subscription {
  return {
    id,
    userRemnaId: ready ? `remna-${id}` : null,
    status: "ACTIVE",
    isTrial,
    trafficLimit: null,
    deviceLimit: null,
    expiresAt: null,
    url: ready ? `https://example.test/${id}` : null,
    plan: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function receipt(
  paymentId: string,
  slotIndex: number,
  slotIndexSource: "CHECKOUT" | "PAYMENT_STATUS" = "CHECKOUT",
  createdAt = slotIndex,
): SubscriptionProvisioningReceipt {
  return {
    version: 1,
    paymentId,
    purchaseType: slotIndex === 0 ? "NEW" : "ADDITIONAL",
    slotIndex,
    slotIndexSource,
    createdAt,
    phase: "PROVISIONING",
  };
}

function trialReceipt(subscriptionId: string): SubscriptionProvisioningReceipt {
  return {
    version: 1,
    paymentId: `trial:${subscriptionId}`,
    source: "TRIAL",
    subscriptionId,
    purchaseType: "NEW",
    slotIndex: 0,
    slotIndexSource: "CHECKOUT",
    createdAt: 0,
    phase: "PROVISIONING",
  };
}

function unboundTrialReceipt(
  knownSubscriptionIds: readonly string[],
): SubscriptionProvisioningReceipt {
  return {
    version: 1,
    paymentId: "trial:pending:1",
    source: "TRIAL",
    knownSubscriptionIds,
    purchaseType: "NEW",
    slotIndex: knownSubscriptionIds.length,
    slotIndexSource: "CHECKOUT",
    createdAt: 1,
    phase: "PROVISIONING",
  };
}

function status(
  paymentId: string,
  subscriptionId: string | null,
  provisioning: PaymentStatus["subscriptionProvisioningStatus"],
): PaymentStatus {
  return {
    paymentId,
    status: "COMPLETED",
    gatewayType: "TEST",
    purchaseType: "NEW",
    amount: "100.00",
    currency: "RUB",
    checkoutUrl: null,
    failureReason: null,
    subscriptionId,
    subscriptionProvisioningStatus: provisioning,
    subscriptionProvisioningFailureCode:
      provisioning === "FAILED" ? "PROFILE_SYNC_FAILED" : null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function publishActiveKeyAsCarouselEffect(
  protectedItemKey: string | null,
  resolvedActiveKey: string | null,
  requestedActiveKey: string | null,
  changes: Array<string | null>,
): void {
  // Mirrors the render/effect boundary in SubscriptionCarousel. The protected
  // snapshot is locally retained while the canonical query has already lost it,
  // so publishing its key would make a controlled parent immediately replace it.
  if (
    protectedItemKey !== null &&
    resolvedActiveKey === protectedItemKey
  ) {
    return;
  }
  if (resolvedActiveKey !== requestedActiveKey) {
    changes.push(resolvedActiveKey);
  }
}

describe("subscription lifecycle policy", () => {
  it("requires both the Remnawave identity and URL", () => {
    expect(isRemnawaveSubscriptionReady(subscription("ready"))).toBe(true);
    expect(isRemnawaveSubscriptionReady(subscription("local", false))).toBe(false);
    expect(
      isRemnawaveSubscriptionReady({
        userRemnaId: "remna",
        url: "   ",
      }),
    ).toBe(false);
  });

  it("replaces an exact early local row with its provisioning item", () => {
    const items = buildSubscriptionCarouselItems(
      [subscription("old"), subscription("new", false)],
      [
        {
          receipt: receipt("payment-new", 1),
          paymentStatus: status("payment-new", "new", "PROFILE_PENDING"),
        },
      ],
    );

    expect(items.map((item) => item.key)).toEqual([
      subscriptionCarouselItemKey("old"),
      provisioningCarouselItemKey("payment-new"),
    ]);
    expect(items[1]).toMatchObject({
      kind: "provisioning",
      slotIndex: 1,
      backendReady: false,
      readySubscription: null,
    });
  });

  it("binds a legacy Trial response to the newly appeared trial row", () => {
    const existing = subscription("existing");
    const localTrial = subscription("trial-created", false, true);
    const receipt = unboundTrialReceipt([existing.id]);
    const paymentStatus = resolveTrialProvisioningPaymentStatus(receipt, [
      existing,
      localTrial,
    ]);

    expect(paymentStatus).toMatchObject({
      subscriptionId: localTrial.id,
      subscriptionProvisioningStatus: "PROFILE_PENDING",
    });
    expect(
      buildSubscriptionCarouselItems(
        [existing, localTrial],
        [{ receipt, paymentStatus }],
      ).map((item) => item.key),
    ).toEqual([
      subscriptionCarouselItemKey(existing.id),
      provisioningCarouselItemKey(receipt.paymentId),
    ]);
  });

  it("does not duplicate a ready checkout row before the first status poll", () => {
    const items = buildSubscriptionCarouselItems(
      [subscription("old"), subscription("new")],
      [
        {
          receipt: receipt("payment-new", 1),
          paymentStatus: null,
        },
      ],
    );

    expect(items.map((item) => item.key)).toEqual([
      subscriptionCarouselItemKey("old"),
      provisioningCarouselItemKey("payment-new"),
    ]);
    expect(items[1]).toMatchObject({
      kind: "provisioning",
      backendReady: false,
      readySubscription: null,
    });
  });

  it("hands off only after READY and the exact real row is usable", () => {
    const real = subscription("new");
    const items = buildSubscriptionCarouselItems(
      [subscription("old"), real],
      [
        {
          receipt: receipt("payment-new", 1),
          paymentStatus: status("payment-new", "new", "READY"),
        },
      ],
    );

    expect(items[1]).toMatchObject({
      kind: "provisioning",
      backendReady: true,
      readySubscription: real,
    });
  });

  it("keeps a free trial in the same creation flow until its Remnawave profile is ready", () => {
    const pendingTrial = trialReceipt("trial");
    const localTrial = subscription("trial", false);
    const pendingStatus = resolveTrialProvisioningPaymentStatus(
      pendingTrial,
      [localTrial],
    );

    expect(pendingStatus).toMatchObject({
      subscriptionId: "trial",
      subscriptionProvisioningStatus: "PROFILE_PENDING",
    });
    expect(
      buildSubscriptionCarouselItems([localTrial], [
        { receipt: pendingTrial, paymentStatus: pendingStatus },
      ]).map((item) => item.key),
    ).toEqual([provisioningCarouselItemKey("trial:trial")]);

    const readyTrial = subscription("trial");
    const readyStatus = resolveTrialProvisioningPaymentStatus(pendingTrial, [
      readyTrial,
    ]);
    const readyItems = buildSubscriptionCarouselItems([readyTrial], [
      { receipt: pendingTrial, paymentStatus: readyStatus },
    ]);

    expect(readyStatus?.subscriptionProvisioningStatus).toBe("READY");
    expect(readyItems[0]).toMatchObject({
      kind: "provisioning",
      backendReady: true,
      readySubscription: readyTrial,
    });
  });

  it("appends a receipt reconstructed from payment status", () => {
    const items = buildSubscriptionCarouselItems(
      [subscription("first"), subscription("second")],
      [
        {
          receipt: receipt("recovered", 0, "PAYMENT_STATUS"),
          paymentStatus: status("recovered", null, "FULFILLING"),
        },
      ],
    );

    expect(items.map((item) => item.key)).toEqual([
      subscriptionCarouselItemKey("first"),
      subscriptionCarouselItemKey("second"),
      provisioningCarouselItemKey("recovered"),
    ]);
    expect(items[2]?.slotIndex).toBe(2);
  });

  it("keeps multiple pending cards in stable creation order", () => {
    const items = buildSubscriptionCarouselItems(
      [subscription("existing")],
      [
        {
          receipt: receipt("second", 2),
          paymentStatus: status("second", null, "FULFILLING"),
        },
        {
          receipt: receipt("first", 1),
          paymentStatus: status("first", null, "FULFILLING"),
        },
      ],
    );

    expect(items.map((item) => item.key)).toEqual([
      subscriptionCarouselItemKey("existing"),
      provisioningCarouselItemKey("first"),
      provisioningCarouselItemKey("second"),
    ]);
  });

  it("keeps concurrent receipts at the same checkout slot in creation order", () => {
    const items = buildSubscriptionCarouselItems(
      [subscription("existing")],
      [
        {
          receipt: receipt("second", 1, "CHECKOUT", 20),
          paymentStatus: status("second", null, "FULFILLING"),
        },
        {
          receipt: receipt("first", 1, "CHECKOUT", 10),
          paymentStatus: status("first", null, "FULFILLING"),
        },
      ],
    );

    expect(items.map((item) => item.key)).toEqual([
      subscriptionCarouselItemKey("existing"),
      provisioningCarouselItemKey("first"),
      provisioningCarouselItemKey("second"),
    ]);
  });

  it("focuses the newest provisioning receipt once", () => {
    const runtimes = [
      {
        receipt: receipt("older", 1, "CHECKOUT", 10),
        paymentStatus: status("older", null, "FULFILLING"),
      },
      {
        receipt: receipt("newer", 1, "CHECKOUT", 20),
        paymentStatus: status("newer", null, "FULFILLING"),
      },
    ];

    expect(
      selectNewestUnfocusedProvisioningKey(runtimes, new Set()),
    ).toBe(provisioningCarouselItemKey("newer"));
    expect(
      selectNewestUnfocusedProvisioningKey(
        runtimes,
        new Set(["newer"]),
      ),
    ).toBe(provisioningCarouselItemKey("older"));
    expect(
      selectNewestUnfocusedProvisioningKey(
        runtimes,
        new Set(["older", "newer"]),
      ),
    ).toBeNull();
  });

  it("requires every exact READY target to be present and usable", () => {
    expect(
      hasAllReadySubscriptionTargets(
        [subscription("first"), subscription("second", false)],
        ["first", "second"],
      ),
    ).toBe(false);
    expect(
      hasAllReadySubscriptionTargets(
        [subscription("first"), subscription("second")],
        ["first", "second"],
      ),
    ).toBe(true);
    expect(hasAllReadySubscriptionTargets([], ["missing"])).toBe(false);
  });

  it("keeps a surviving active item and selects the nearest neighbour otherwise", () => {
    const keys = ["a", "b", "c"];
    expect(selectCarouselItemAfterRemoval(keys, "b", "a")).toBe("a");
    expect(selectCarouselItemAfterRemoval(keys, "b", "b")).toBe("c");
    expect(selectCarouselItemAfterRemoval(keys, "c", "c")).toBe("b");
    expect(selectCarouselItemAfterRemoval(["only"], "only", "only")).toBeNull();
  });

  it("repairs a stale active key deterministically", () => {
    expect(resolveActiveCarouselItemKey(["a", "b"], "missing")).toBe("a");
    expect(resolveActiveCarouselItemKey(["a", "b"], "b")).toBe("b");
    expect(resolveActiveCarouselItemKey([], "b")).toBeNull();
  });

  it("retains a disappearing active middle card and defers its neighbour handoff until exit completes", () => {
    const deleting = { key: "b", slotIndex: 1 };
    const rendered = retainCarouselItemDuringDeletion(
      [
        { key: "a", slotIndex: 0 },
        { key: "c", slotIndex: 2 },
      ],
      deleting,
    );

    expect(rendered).toEqual([
      { key: "a", slotIndex: 0 },
      { key: "b", slotIndex: 1 },
      { key: "c", slotIndex: 2 },
    ]);
    const activeKey = resolveActiveCarouselItemKeyDuringDeletion(
      rendered.map((item) => item.key),
      deleting.key,
      deleting.key,
    );
    const activeKeyChanges: Array<string | null> = [];

    // This is the render/effect boundary in SubscriptionCarousel: a protected
    // active slide must not publish an intermediate key while its exit is live.
    publishActiveKeyAsCarouselEffect(
      deleting.key,
      activeKey,
      deleting.key,
      activeKeyChanges,
    );
    expect(activeKey).toBe(deleting.key);
    expect(activeKeyChanges).toEqual([]);

    // finishCommittedDeletion is the first point at which a neighbour may be
    // selected. With a three-card carousel, the middle item hands off right.
    activeKeyChanges.push(
      selectCarouselItemAfterRemoval(
        rendered.map((item) => item.key),
        deleting.key,
        activeKey,
      ),
    );
    expect(activeKeyChanges).toEqual(["c"]);
  });

  it("retains the sole deletion snapshot when realtime empties the canonical list", () => {
    const deleting = { key: "only", slotIndex: 0 };

    expect(retainCarouselItemDuringDeletion([], deleting)).toEqual([deleting]);
  });

  it("keeps a delete target renderable if realtime wins before server commit", () => {
    const deleteTarget = { key: "b", slotIndex: 1 };
    const rendered = retainCarouselItemDuringDeletion(
      [
        { key: "a", slotIndex: 0 },
        { key: "c", slotIndex: 2 },
      ],
      deleteTarget,
    );
    const activeKey = resolveActiveCarouselItemKeyDuringDeletion(
      rendered.map((item) => item.key),
      deleteTarget.key,
      null,
    );

    expect(rendered.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect(activeKey).toBe(deleteTarget.key);
    // The same protected-item guard keeps the parent callback silent while
    // the confirmation dialog still owns the target snapshot.
    const activeKeyChanges: Array<string | null> = [];
    publishActiveKeyAsCarouselEffect(
      deleteTarget.key,
      activeKey,
      deleteTarget.key,
      activeKeyChanges,
    );
    expect(activeKeyChanges).toEqual([]);
  });

  it("keeps first and last deletion snapshots anchored without duplicating them", () => {
    const first = retainCarouselItemDuringDeletion(
      [
        { key: "b", slotIndex: 1 },
        { key: "c", slotIndex: 2 },
      ],
      { key: "a", slotIndex: 0 },
    );
    const last = retainCarouselItemDuringDeletion(
      [
        { key: "a", slotIndex: 0 },
        { key: "b", slotIndex: 1 },
      ],
      { key: "c", slotIndex: 2 },
    );
    const unchanged = retainCarouselItemDuringDeletion(
      [
        { key: "a", slotIndex: 0 },
        { key: "b", slotIndex: 1 },
      ],
      { key: "b", slotIndex: 1 },
    );

    expect(first).toEqual([
      { key: "a", slotIndex: 0 },
      { key: "b", slotIndex: 1 },
      { key: "c", slotIndex: 2 },
    ]);
    expect(last).toEqual([
      { key: "a", slotIndex: 0 },
      { key: "b", slotIndex: 1 },
      { key: "c", slotIndex: 2 },
    ]);
    expect(unchanged.map((item) => item.key)).toEqual(["a", "b"]);
    expect(
      selectCarouselItemAfterRemoval(
        first.map((item) => item.key),
        "a",
        "a",
      ),
    ).toBe("b");
    expect(
      selectCarouselItemAfterRemoval(
        last.map((item) => item.key),
        "c",
        "c",
      ),
    ).toBe("b");
  });
});
