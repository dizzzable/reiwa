import { describe, expect, it } from "vitest";

import {
  PaymentsNamespace,
  type PaymentStatusResponse,
} from "../../src/infrastructure/admin-client/namespaces/payments.js";

describe("PaymentsNamespace.getStatus contract", () => {
  it("preserves the complete status payload and scopes the lookup to its owner", async () => {
    const response: PaymentStatusResponse = {
      paymentId: "payment/1",
      status: "COMPLETED",
      gatewayType: "YOOKASSA",
      purchaseType: "ADDITIONAL",
      amount: "199.90",
      currency: "RUB",
      checkoutUrl: null,
      failureReason: null,
      subscriptionId: "subscription-1",
      subscriptionProvisioningStatus: "PROFILE_PENDING",
      subscriptionProvisioningFailureCode: null,
      updatedAt: "2026-07-23T12:00:00.000Z",
    };
    const calls: Array<{ method: string; path: string }> = [];
    const transport = {
      request: async (method: string, path: string) => {
        calls.push({ method, path });
        return response;
      },
    };

    const result = await new PaymentsNamespace(
      transport as never,
    ).getStatus("payment/1", {
      userId: "user/1",
      telegramId: "telegram+1",
    });

    expect(calls).toEqual([
      {
        method: "GET",
        path:
          "/api/internal/payments/payment%2F1" +
          "?userId=user%2F1&telegramId=telegram%2B1",
      },
    ]);
    expect(result).toBe(response);
    expect(result.amount).toBe("199.90");
    expect(result.subscriptionProvisioningStatus).toBe("PROFILE_PENDING");
  });
});
