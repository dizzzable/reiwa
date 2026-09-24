import express from "express";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createSubscriptionRouter } from "../../src/api/routes/subscription.js";

/**
 * `POST /subscription/quote` passes the panel's `paidRemainderDays` — the days
 * the old plan's paid remainder adds to an upgraded term — to the review, as a
 * whole non-negative number, and nothing else.
 */
function makeApp(getQuote: () => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.webSession = { userId: "user-cuid-1", createdAt: 0, ip: "127.0.0.1", lastActivity: 0 };
    next();
  });
  app.use(
    "/api/v1",
    createSubscriptionRouter({
      adminClient: { subscription: { getQuote } } as never,
      sessionStore: null,
      config: {} as never,
    }),
  );
  return app;
}

async function quote(panelQuote: unknown): Promise<Record<string, unknown>> {
  const app = makeApp(vi.fn(async () => panelQuote));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const payload = JSON.stringify({
    planId: "plan-b",
    durationDays: 30,
    gatewayType: "YOOKASSA",
    purchaseType: "UPGRADE",
    subscriptionId: "sub-1",
  });
  try {
    const answer = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/v1/subscription/quote",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
          });
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
    expect(answer.status).toBe(200);
    return answer.body;
  } finally {
    server.close();
  }
}

/** A priced UPGRADE quote as the panel answers it. */
function panelQuote(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selectedPlan: { id: "plan-b", name: "Plan B" },
    selectedDuration: { id: "d-30", days: 30 },
    price: { gatewayType: "YOOKASSA", currency: "RUB", originalPrice: "650", price: "650", discountPercent: 0 },
    warnings: [{ code: "UPGRADE_RESETS_EXPIRY", message: "Upgrade starts immediately and resets the expiration date." }],
    isEligible: true,
    carriedAbovePlan: null,
    ...extra,
  };
}

describe("subscription quote route: the old plan's paid remainder", () => {
  it("passes the panel's estimate to the review", async () => {
    const flat = await quote(panelQuote({ paidRemainderDays: 8 }));

    expect(flat.paidRemainderDays).toBe(8);
    expect(flat.finalPrice).toBe(650);
    expect(flat.warning).toBeUndefined();
  });

  it("passes 0, which the review reads as nothing to add", async () => {
    const flat = await quote(panelQuote({ paidRemainderDays: 0 }));

    expect(flat.paidRemainderDays).toBe(0);
  });

  it("adds nothing for a panel older than the field, or one that could not estimate", async () => {
    expect(await quote(panelQuote())).not.toHaveProperty("paidRemainderDays");
    expect(await quote(panelQuote({ paidRemainderDays: null }))).not.toHaveProperty("paidRemainderDays");
  });

  it("drops anything but a whole non-negative number rather than show it", async () => {
    for (const malformed of [-1, 1.5, "8", true, 1e20, { days: 8 }]) {
      const flat = await quote(panelQuote({ paidRemainderDays: malformed }));
      expect(flat, JSON.stringify(malformed)).not.toHaveProperty("paidRemainderDays");
      expect(flat.finalPrice, "the quote itself is untouched").toBe(650);
    }
  });

  it("keeps what an upgrade keeps above the plan beside it", async () => {
    const carried = { deviceLimit: 2, trafficLimitGb: 10, unlimitedDevices: false, unlimitedTraffic: false };
    const flat = await quote(panelQuote({ paidRemainderDays: 6, carriedAbovePlan: carried }));

    expect(flat.paidRemainderDays).toBe(6);
    expect(flat.carriedAbovePlan).toEqual(carried);
  });
});
