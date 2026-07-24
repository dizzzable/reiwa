import {
  isTrialSubscriptionProvisioningReceipt,
  type SubscriptionProvisioningReceipt,
} from "../../lib/subscription-provisioning-receipt.js";
import type { PaymentStatus, Subscription } from "@/types/api";

export interface SubscriptionProvisioningRuntime {
  readonly receipt: SubscriptionProvisioningReceipt;
  readonly paymentStatus: PaymentStatus | null;
}

export interface SubscriptionCarouselSubscriptionItem {
  readonly kind: "subscription";
  readonly key: string;
  readonly slotIndex: number;
  readonly subscription: Subscription;
}

export interface SubscriptionCarouselProvisioningItem {
  readonly kind: "provisioning";
  readonly key: string;
  readonly slotIndex: number;
  readonly receipt: SubscriptionProvisioningReceipt;
  readonly paymentStatus: PaymentStatus | null;
  readonly backendReady: boolean;
  readonly failed: boolean;
  readonly readySubscription: Subscription | null;
}

export type SubscriptionCarouselItem =
  | SubscriptionCarouselSubscriptionItem
  | SubscriptionCarouselProvisioningItem;

interface AnchoredCarouselItem {
  readonly anchor: number;
  readonly createdAt: number;
  readonly tieBreak: string;
  readonly item: SubscriptionCarouselItem;
}

export function subscriptionCarouselItemKey(subscriptionId: string): string {
  return `subscription:${subscriptionId}`;
}

export function provisioningCarouselItemKey(paymentId: string): string {
  return `provisioning:${paymentId}`;
}

export function isRemnawaveSubscriptionReady(
  subscription: Pick<Subscription, "userRemnaId" | "url">,
): boolean {
  return (
    typeof subscription.userRemnaId === "string" &&
    subscription.userRemnaId.trim().length > 0 &&
    typeof subscription.url === "string" &&
    subscription.url.trim().length > 0
  );
}

/**
 * Free trials do not create a payment resource. Convert their exact local
 * subscription target into the same runtime contract as paid provisioning so
 * the carousel can keep one animation and handoff path.
 */
export function resolveTrialProvisioningPaymentStatus(
  receipt: SubscriptionProvisioningReceipt,
  subscriptions: readonly Subscription[],
): PaymentStatus | null {
  if (!isTrialSubscriptionProvisioningReceipt(receipt)) return null;

  const subscriptionId = resolveTrialSubscriptionId(receipt, subscriptions);
  const ready =
    subscriptionId !== null &&
    hasAllReadySubscriptionTargets(subscriptions, [subscriptionId]);
  return {
    paymentId: receipt.paymentId,
    status: "COMPLETED",
    gatewayType: "TRIAL",
    purchaseType: "NEW",
    amount: "0",
    currency: "",
    checkoutUrl: null,
    failureReason: null,
    subscriptionId,
    subscriptionProvisioningStatus: ready ? "READY" : "PROFILE_PENDING",
    subscriptionProvisioningFailureCode: null,
    updatedAt: new Date(receipt.createdAt).toISOString(),
  };
}

function resolveTrialSubscriptionId(
  receipt: SubscriptionProvisioningReceipt,
  subscriptions: readonly Subscription[],
): string | null {
  if (
    typeof receipt.subscriptionId === "string" &&
    receipt.subscriptionId.length > 0
  ) {
    return receipt.subscriptionId;
  }

  const knownSubscriptionIds = new Set(receipt.knownSubscriptionIds ?? []);
  return (
    subscriptions.find(
      (subscription) =>
        subscription.isTrial && !knownSubscriptionIds.has(subscription.id),
    )?.id ?? null
  );
}

/**
 * Builds a carousel that contains real server subscriptions plus transient
 * provisioning receipts. A local ACTIVE row tied to a receipt stays hidden
 * until its exact Remnawave identity and URL are ready.
 */
export function buildSubscriptionCarouselItems(
  subscriptions: readonly Subscription[],
  runtimes: readonly SubscriptionProvisioningRuntime[],
): SubscriptionCarouselItem[] {
  const orderedRuntimes = [...runtimes].sort(
    (left, right) =>
      effectiveReceiptSlot(left.receipt, subscriptions.length) -
        effectiveReceiptSlot(right.receipt, subscriptions.length) ||
      left.receipt.createdAt - right.receipt.createdAt ||
      left.receipt.paymentId.localeCompare(right.receipt.paymentId),
  );
  const hiddenSubscriptionIds = new Set<string>();

  for (const runtime of orderedRuntimes) {
    const exactId = runtime.paymentStatus?.subscriptionId;
    if (typeof exactId === "string" && exactId.length > 0) {
      hiddenSubscriptionIds.add(exactId);
      continue;
    }

    const candidate =
      runtime.receipt.slotIndexSource === "CHECKOUT"
        ? subscriptions[runtime.receipt.slotIndex]
        : findNewestUnreadySubscription(
            subscriptions,
            hiddenSubscriptionIds,
          );
    if (candidate !== undefined) {
      hiddenSubscriptionIds.add(candidate.id);
    }
  }

  const anchoredItems: AnchoredCarouselItem[] = [];

  subscriptions.forEach((subscription, sourceIndex) => {
    if (hiddenSubscriptionIds.has(subscription.id)) return;
    anchoredItems.push({
      anchor: sourceIndex * 2,
      createdAt: 0,
      tieBreak: subscription.id,
      item: {
        kind: "subscription",
        key: subscriptionCarouselItemKey(subscription.id),
        slotIndex: 0,
        subscription,
      },
    });
  });

  for (const runtime of orderedRuntimes) {
    const exactSubscription =
      typeof runtime.paymentStatus?.subscriptionId === "string"
        ? subscriptions.find(
            (subscription) =>
              subscription.id === runtime.paymentStatus?.subscriptionId,
          ) ?? null
        : null;
    const readySubscription =
      exactSubscription !== null &&
      isRemnawaveSubscriptionReady(exactSubscription)
        ? exactSubscription
        : null;
    const desiredSlot = effectiveReceiptSlot(
      runtime.receipt,
      subscriptions.length,
    );
    const provisioningStatus =
      runtime.paymentStatus?.subscriptionProvisioningStatus;
    const failed =
      runtime.paymentStatus?.status === "FAILED" ||
      runtime.paymentStatus?.status === "CANCELED" ||
      provisioningStatus === "FAILED";

    anchoredItems.push({
      // A checkout slot is the number of real rows that existed before the
      // purchase, so place the transient card between source indices
      // slot-1 and slot. The odd anchor also keeps concurrent receipts at the
      // same slot in creation order instead of reversing repeated splices.
      anchor: desiredSlot * 2 - 1,
      createdAt: runtime.receipt.createdAt,
      tieBreak: runtime.receipt.paymentId,
      item: {
        kind: "provisioning",
        key: provisioningCarouselItemKey(runtime.receipt.paymentId),
        slotIndex: 0,
        receipt: runtime.receipt,
        paymentStatus: runtime.paymentStatus,
        backendReady: provisioningStatus === "READY",
        failed,
        readySubscription,
      },
    });
  }

  return anchoredItems
    .sort(
      (left, right) =>
        left.anchor - right.anchor ||
        left.createdAt - right.createdAt ||
        left.tieBreak.localeCompare(right.tieBreak),
    )
    .map(({ item }, slotIndex) => ({ ...item, slotIndex }));
}

export function selectNewestUnfocusedProvisioningKey(
  runtimes: readonly SubscriptionProvisioningRuntime[],
  focusedPaymentIds: ReadonlySet<string>,
): string | null {
  let selected: SubscriptionProvisioningRuntime | null = null;
  for (const runtime of runtimes) {
    if (focusedPaymentIds.has(runtime.receipt.paymentId)) continue;
    if (
      selected === null ||
      runtime.receipt.createdAt > selected.receipt.createdAt ||
      (runtime.receipt.createdAt === selected.receipt.createdAt &&
        runtime.receipt.paymentId.localeCompare(selected.receipt.paymentId) > 0)
    ) {
      selected = runtime;
    }
  }
  return selected === null
    ? null
    : provisioningCarouselItemKey(selected.receipt.paymentId);
}

export function hasAllReadySubscriptionTargets(
  subscriptions: readonly Subscription[],
  targetSubscriptionIds: readonly string[],
): boolean {
  return (
    targetSubscriptionIds.length > 0 &&
    targetSubscriptionIds.every((targetId) => {
      const subscription = subscriptions.find(
        (candidate) => candidate.id === targetId,
      );
      return (
        subscription !== undefined &&
        isRemnawaveSubscriptionReady(subscription)
      );
    })
  );
}

export function resolveActiveCarouselItemKey(
  itemKeys: readonly string[],
  preferredKey: string | null,
): string | null {
  if (preferredKey !== null && itemKeys.includes(preferredKey)) {
    return preferredKey;
  }
  return itemKeys[0] ?? null;
}

export function selectCarouselItemAfterRemoval(
  itemKeys: readonly string[],
  removedKey: string,
  activeKey: string | null,
): string | null {
  const removedIndex = itemKeys.indexOf(removedKey);
  const remainingKeys = itemKeys.filter((key) => key !== removedKey);
  if (
    activeKey !== null &&
    activeKey !== removedKey &&
    remainingKeys.includes(activeKey)
  ) {
    return activeKey;
  }
  if (remainingKeys.length === 0) return null;
  if (removedIndex < 0) {
    return resolveActiveCarouselItemKey(remainingKeys, activeKey);
  }
  return remainingKeys[Math.min(removedIndex, remainingKeys.length - 1)] ?? null;
}

function effectiveReceiptSlot(
  receipt: SubscriptionProvisioningReceipt,
  realSubscriptionCount: number,
): number {
  return receipt.slotIndexSource === "PAYMENT_STATUS"
    ? realSubscriptionCount
    : Math.min(receipt.slotIndex, realSubscriptionCount);
}

function findNewestUnreadySubscription(
  subscriptions: readonly Subscription[],
  hiddenSubscriptionIds: ReadonlySet<string>,
): Subscription | undefined {
  for (let index = subscriptions.length - 1; index >= 0; index -= 1) {
    const candidate = subscriptions[index];
    if (
      candidate !== undefined &&
      !hiddenSubscriptionIds.has(candidate.id) &&
      !isRemnawaveSubscriptionReady(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}
