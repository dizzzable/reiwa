import { afterEach, describe, expect, it, vi } from "vitest";

import { payWithPartnerBalance } from "@/lib/api-client/partner";
import { createCheckout, createUpgradeCheckout } from "@/lib/api-client/payments";
import { apiClient } from "@/lib/api-client/transport";

/**
 * WHAT A PURCHASE PUTS ON THE WIRE: NO DEVICE.
 *
 * The purchase wizard asked «На каком устройстве?» and sent the answer as
 * `deviceType` — through the gateway checkout, a trial's conversion and the
 * partner balance alike. Nothing read it, and the question suggested a
 * subscription is tied to one device, so it is gone. The wizard's side is
 * pinned in `purchase-no-device-step.test.tsx` (and the conversion's in
 * `purchase-trial-conversion.test.tsx`); this pins the client's half: each body
 * exactly as posted, so no `deviceType` — nor any other stray field — rides
 * along. `toEqual` skips a field left undefined, as `JSON.stringify` does.
 *
 * The cabinet's routes still accept the field, for SPA bundles cached before
 * its removal; nothing here touches that.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a purchase's requests carry no deviceType", () => {
  it("a new subscription through a gateway", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { paymentId: "pay-1" } });

    await createCheckout("plan-p", 30, "YOOKASSA", null, false, false, "ADDITIONAL");

    expect(post.mock.calls).toEqual([
      [
        "/payments/checkout",
        {
          planId: "plan-p",
          durationDays: 30,
          gatewayType: "YOOKASSA",
          purchaseType: "ADDITIONAL",
          source: "web",
          savePaymentMethod: false,
          savePaymentMethodConsent: false,
        },
      ],
    ]);
  });

  it("a trial's conversion through a gateway", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { paymentId: "pay-2" } });

    await createUpgradeCheckout("plan-p", 30, "PLATEGA", "trial-1", null, undefined, true);

    expect(post.mock.calls).toEqual([
      [
        "/payments/checkout",
        {
          planId: "plan-p",
          durationDays: 30,
          gatewayType: "PLATEGA",
          purchaseType: "UPGRADE",
          subscriptionId: "trial-1",
          source: "web",
          savePaymentMethodConsent: true,
        },
      ],
    ]);
  });

  it("the partner balance", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { paymentId: "balance-1" } });

    await payWithPartnerBalance({ purchaseType: "NEW", planId: "plan-p", durationDays: 30 });

    expect(post.mock.calls).toEqual([
      ["/partner/pay", { purchaseType: "NEW", planId: "plan-p", durationDays: 30 }],
    ]);
  });
});
