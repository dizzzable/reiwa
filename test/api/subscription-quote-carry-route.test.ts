import express from "express";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createSubscriptionRouter } from "../../src/api/routes/subscription.js";

/**
 * `POST /subscription/quote` re-states the panel's `carriedAbovePlan` — what an
 * upgrade keeps above the new plan — for the review's one line, and says
 * nothing when the panel sends none or sends something that is not the shape.
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
    price: { gatewayType: "YOOKASSA", currency: "RUB", originalPrice: "300", price: "300", discountPercent: 0 },
    warnings: [{ code: "UPGRADE_RESETS_EXPIRY", message: "Upgrade starts immediately and resets the expiration date." }],
    isEligible: true,
    ...extra,
  };
}

const CARRIED = { deviceLimit: 2, trafficLimitGb: 10, unlimitedDevices: false, unlimitedTraffic: false };

describe("subscription quote route: what an upgrade keeps above the plan", () => {
  it("passes the panel's carriedAbovePlan to the review", async () => {
    const flat = await quote(panelQuote({ carriedAbovePlan: CARRIED }));

    expect(flat.carriedAbovePlan).toEqual(CARRIED);
    expect(flat.finalPrice).toBe(300);
    expect(flat.warning).toBeUndefined();
  });

  it("adds nothing for a panel older than the field", async () => {
    const flat = await quote(panelQuote());

    expect(flat).not.toHaveProperty("carriedAbovePlan");
    expect(flat.finalPrice).toBe(300);
  });

  it("adds nothing when nothing carries", async () => {
    const flat = await quote(
      panelQuote({
        carriedAbovePlan: { deviceLimit: 0, trafficLimitGb: 0, unlimitedDevices: false, unlimitedTraffic: false },
      }),
    );

    expect(flat).not.toHaveProperty("carriedAbovePlan");
  });

  it("drops a field that is not whole counts and two booleans rather than show it", async () => {
    for (const malformed of [
      { ...CARRIED, deviceLimit: -2 },
      { ...CARRIED, trafficLimitGb: 1.5 },
      { ...CARRIED, deviceLimit: "2" },
      { ...CARRIED, unlimitedDevices: "no" },
      { deviceLimit: 2, trafficLimitGb: 10 },
      "2 devices",
    ]) {
      const flat = await quote(panelQuote({ carriedAbovePlan: malformed }));
      expect(flat, JSON.stringify(malformed)).not.toHaveProperty("carriedAbovePlan");
    }
  });

  it("keeps only the four known fields", async () => {
    const flat = await quote(panelQuote({ carriedAbovePlan: { ...CARRIED, note: "<b>x</b>" } }));

    expect(flat.carriedAbovePlan).toEqual(CARRIED);
  });
});
