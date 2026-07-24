import { describe, expect, it } from "vitest";

import { ReferralsNamespace } from "../../../src/infrastructure/admin-client/namespaces/referrals.js";

function namespaceWith(request: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const transport = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return request(method, path, body);
    },
  };
  return { namespace: new ReferralsNamespace(transport as never), calls };
}

describe("ReferralsNamespace exchange contract", () => {
  it("forwards subscriptionId and idempotencyKey for exchange requests", async () => {
    const { namespace, calls } = namespaceWith(async () => ({ success: true, syncPending: true }));

    await namespace.exchangePoints(
      { userId: "user-7" },
      {
        type: "SUBSCRIPTION_DAYS",
        points: 480,
        subscriptionId: "sub-7",
        idempotencyKey: "idem-7",
      },
    );

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/api/internal/user/user-7/referrals/exchange");
    expect(calls[0]?.body).toEqual({
      type: "SUBSCRIPTION_DAYS",
      points: 480,
      subscriptionId: "sub-7",
      idempotencyKey: "idem-7",
    });
  });
});
