import express from "express";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createSubscriptionRouter } from "../../src/api/routes/subscription.js";

function makeApp(
  getActionPolicy: (
    identity: Record<string, unknown>,
    subscriptionId?: string,
  ) => Promise<unknown>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // `WebSession` also carries the bookkeeping the store maintains; the route
    // only reads `userId`, but the shape has to be whole.
    req.webSession = { userId: "user-cuid-1", createdAt: 0, ip: "127.0.0.1", lastActivity: 0 };
    next();
  });
  app.use(
    "/api/v1",
    createSubscriptionRouter({
      adminClient: { subscription: { getActionPolicy } } as never,
      sessionStore: null,
      config: {} as never,
    }),
  );
  return app;
}

async function post(
  app: express.Express,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const payload = JSON.stringify(body);

  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/v1/subscription/action-policy",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: data ? JSON.parse(data) : null,
            });
          });
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
  } finally {
    server.close();
  }
}

describe("subscription action-policy route", () => {
  it("forwards the exact selected subscriptionId and flattens its policy", async () => {
    const getActionPolicy = vi.fn(async () => ({
      actions: {
        NEW: true,
        ADDITIONAL: true,
        RENEW: false,
        UPGRADE: true,
        TRIAL: false,
      },
      activeSubscriptionCount: 2,
      maxSubscriptions: 4,
    }));

    const response = await post(makeApp(getActionPolicy), {
      subscriptionId: "subscription-2",
    });

    expect(response.status).toBe(200);
    expect(getActionPolicy).toHaveBeenCalledWith(
      { userId: "user-cuid-1" },
      "subscription-2",
    );
    expect(response.body).toMatchObject({
      canBuy: true,
      canRenew: false,
      canUpgrade: true,
      canTrial: false,
      activeSubscriptionCount: 2,
      maxSubscriptions: 4,
      limitReached: false,
    });
  });

  it("says the selected subscription has no end date when the panel does, and not otherwise", async () => {
    // The panel closes RENEW for a subscription with no end date and says why
    // in a warning; the SPA needs the why, because the subscription list shows
    // the VPN panel's date for it. A panel older than the rule says nothing,
    // and the flag stays false — the page behaves as it did.
    const lifetime = vi.fn(async () => ({
      actions: { RENEW: false, UPGRADE: true },
      warnings: [{ code: "SUBSCRIPTION_IS_LIFETIME", message: "no end date" }],
    }));
    const older = vi.fn(async () => ({ actions: { RENEW: true }, warnings: [] }));

    const answered = await post(makeApp(lifetime), { subscriptionId: "subscription-1" });
    const fromOlderPanel = await post(makeApp(older), { subscriptionId: "subscription-1" });

    expect(answered.body).toMatchObject({ canRenew: false, lifetime: true });
    expect(fromOlderPanel.body).toMatchObject({ canRenew: true, lifetime: false });
  });

  it("keeps the portfolio policy unscoped when no subscription is selected", async () => {
    const getActionPolicy = vi.fn(async () => ({ actions: {} }));

    const response = await post(makeApp(getActionPolicy), {});

    expect(response.status).toBe(200);
    expect(getActionPolicy).toHaveBeenCalledWith(
      { userId: "user-cuid-1" },
      undefined,
    );
  });
});
