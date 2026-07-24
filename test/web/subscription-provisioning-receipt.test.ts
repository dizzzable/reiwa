import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_PROVISIONING_RECEIPT_MAX_ENTRIES,
  SUBSCRIPTION_PROVISIONING_RECEIPT_TTL_MS,
  clearSubscriptionProvisioningReceipt,
  ensureSubscriptionProvisioningReceipt,
  isTrialSubscriptionProvisioningReceipt,
  listSubscriptionProvisioningReceipts,
  readSubscriptionProvisioningReceipt,
  saveSubscriptionProvisioningReceipt,
  saveTrialSubscriptionProvisioningReceipt,
  shouldTrackSubscriptionProvisioningReceipt,
  type SubscriptionProvisioningReceiptStorage,
} from "../../web/src/lib/subscription-provisioning-receipt.js";

const STORAGE_KEY = "reiwa:subscription-provisioning-receipts";
const NOW = Date.UTC(2026, 6, 23, 12);

class MemoryStorage implements SubscriptionProvisioningReceiptStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("subscription provisioning receipt store", () => {
  it("survives a fresh reader and does not depend on a checkout URL", () => {
    const storage = new MemoryStorage();

    expect(
      saveSubscriptionProvisioningReceipt(
        {
          paymentId: "payment-1",
          purchaseType: "NEW",
          slotIndex: 0,
          slotIndexSource: "CHECKOUT",
          phase: "AWAITING_PAYMENT",
        },
        { storage, now: NOW },
      ),
    ).toMatchObject({
      version: 1,
      paymentId: "payment-1",
      phase: "AWAITING_PAYMENT",
    });

    // A new module consumer after a refresh sees the same session record.
    expect(
      readSubscriptionProvisioningReceipt("payment-1", {
        storage,
        now: NOW + 1000,
      }),
    ).toEqual({
      version: 1,
      paymentId: "payment-1",
      purchaseType: "NEW",
      slotIndex: 0,
      slotIndexSource: "CHECKOUT",
      createdAt: NOW,
      phase: "AWAITING_PAYMENT",
    });
  });

  it("keeps multiple payments isolated and clears only the requested receipt", () => {
    const storage = new MemoryStorage();
    saveSubscriptionProvisioningReceipt(
      {
        paymentId: "payment-1",
        purchaseType: "NEW",
        slotIndex: 0,
        slotIndexSource: "CHECKOUT",
        phase: "AWAITING_PAYMENT",
      },
      { storage, now: NOW },
    );
    saveSubscriptionProvisioningReceipt(
      {
        paymentId: "payment-2",
        purchaseType: "ADDITIONAL",
        slotIndex: 1,
        slotIndexSource: "CHECKOUT",
        phase: "PROVISIONING",
      },
      { storage, now: NOW + 10 },
    );

    expect(listSubscriptionProvisioningReceipts({ storage, now: NOW + 20 })).toHaveLength(2);
    clearSubscriptionProvisioningReceipt("payment-1", { storage, now: NOW + 20 });
    expect(readSubscriptionProvisioningReceipt("payment-1", { storage, now: NOW + 20 })).toBeNull();
    expect(readSubscriptionProvisioningReceipt("payment-2", { storage, now: NOW + 20 })?.phase).toBe(
      "PROVISIONING",
    );
  });

  it("persists a free trial as a direct provisioning target", () => {
    const storage = new MemoryStorage();
    const receipt = saveTrialSubscriptionProvisioningReceipt(
      {
        subscriptionId: "trial-subscription",
        slotIndex: 0,
      },
      { storage, now: NOW },
    );

    expect(receipt).toMatchObject({
      paymentId: "trial:trial-subscription",
      source: "TRIAL",
      subscriptionId: "trial-subscription",
      purchaseType: "NEW",
      phase: "PROVISIONING",
    });
    expect(
      receipt === null
        ? false
        : isTrialSubscriptionProvisioningReceipt(receipt),
    ).toBe(true);
    expect(
      readSubscriptionProvisioningReceipt("trial:trial-subscription", {
        storage,
        now: NOW + 1,
      }),
    ).toMatchObject({
      source: "TRIAL",
      subscriptionId: "trial-subscription",
    });
  });

  it("persists an unbound free trial until a legacy response can be resolved", () => {
    const storage = new MemoryStorage();
    const receipt = saveTrialSubscriptionProvisioningReceipt(
      {
        knownSubscriptionIds: ["subscription-before-trial"],
        slotIndex: 1,
      },
      { storage, now: NOW },
    );

    expect(receipt).toMatchObject({
      paymentId: `trial:pending:${NOW}`,
      source: "TRIAL",
      knownSubscriptionIds: ["subscription-before-trial"],
      phase: "PROVISIONING",
    });
    expect(receipt?.subscriptionId).toBeUndefined();
    expect(receipt === null ? false : isTrialSubscriptionProvisioningReceipt(receipt)).toBe(true);
  });

  it("recovers a missing new-tab receipt and never regresses its phase", () => {
    const storage = new MemoryStorage();
    const recovered = ensureSubscriptionProvisioningReceipt(
      {
        paymentId: "payment-new-tab",
        purchaseType: "ADDITIONAL",
        slotIndex: 0,
        slotIndexSource: "PAYMENT_STATUS",
        phase: "PROVISIONING",
      },
      { storage, now: NOW },
    );
    expect(recovered).toMatchObject({
      slotIndex: 0,
      slotIndexSource: "PAYMENT_STATUS",
      phase: "PROVISIONING",
    });

    ensureSubscriptionProvisioningReceipt(
      {
        paymentId: "payment-new-tab",
        purchaseType: "ADDITIONAL",
        slotIndex: 0,
        slotIndexSource: "PAYMENT_STATUS",
        phase: "AWAITING_PAYMENT",
      },
      { storage, now: NOW + 100 },
    );
    expect(
      readSubscriptionProvisioningReceipt("payment-new-tab", {
        storage,
        now: NOW + 100,
      })?.phase,
    ).toBe("PROVISIONING");
  });

  it("drops corrupted, legacy, and expired data without throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "{broken");
    expect(listSubscriptionProvisioningReceipts({ storage, now: NOW })).toEqual([]);

    storage.setItem(STORAGE_KEY, JSON.stringify({ "payment-legacy": { paymentId: "payment-legacy" } }));
    expect(listSubscriptionProvisioningReceipts({ storage, now: NOW })).toEqual([]);

    saveSubscriptionProvisioningReceipt(
      {
        paymentId: "payment-expired",
        purchaseType: "NEW",
        slotIndex: 0,
        slotIndexSource: "CHECKOUT",
        phase: "PROVISIONING",
      },
      { storage, now: NOW },
    );
    expect(
      readSubscriptionProvisioningReceipt("payment-expired", {
        storage,
        now: NOW + SUBSCRIPTION_PROVISIONING_RECEIPT_TTL_MS + 1,
      }),
    ).toBeNull();
  });

  it("retains only the newest bounded set", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < SUBSCRIPTION_PROVISIONING_RECEIPT_MAX_ENTRIES + 2; index += 1) {
      saveSubscriptionProvisioningReceipt(
        {
          paymentId: `payment-${index}`,
          purchaseType: index === 0 ? "NEW" : "ADDITIONAL",
          slotIndex: index,
          slotIndexSource: "CHECKOUT",
          phase: "AWAITING_PAYMENT",
        },
        { storage, now: NOW + index },
      );
    }

    const receipts = listSubscriptionProvisioningReceipts({
      storage,
      now: NOW + SUBSCRIPTION_PROVISIONING_RECEIPT_MAX_ENTRIES + 2,
    });
    expect(receipts).toHaveLength(SUBSCRIPTION_PROVISIONING_RECEIPT_MAX_ENTRIES);
    expect(receipts.some((receipt) => receipt.paymentId === "payment-0")).toBe(false);
    expect(receipts.some((receipt) => receipt.paymentId === "payment-1")).toBe(false);
  });

  it("does not mistake an ADDITIONAL add-on payment for subscription creation", () => {
    expect(
      shouldTrackSubscriptionProvisioningReceipt({
        purchaseType: "ADDITIONAL",
        subscriptionProvisioningStatus: "NOT_APPLICABLE",
        hasExistingReceipt: false,
        returnTo: "/addons",
      }),
    ).toBe(false);
    expect(
      shouldTrackSubscriptionProvisioningReceipt({
        purchaseType: "ADDITIONAL",
        subscriptionProvisioningStatus: "NOT_APPLICABLE",
        hasExistingReceipt: true,
        returnTo: "/plans",
      }),
    ).toBe(true);
    expect(
      shouldTrackSubscriptionProvisioningReceipt({
        purchaseType: "ADDITIONAL",
        subscriptionProvisioningStatus: "PROFILE_PENDING",
        hasExistingReceipt: false,
      }),
    ).toBe(true);
  });
});
