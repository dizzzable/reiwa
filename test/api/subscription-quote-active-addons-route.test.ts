import express from "express";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createSubscriptionRouter } from "../../src/api/routes/subscription.js";

/**
 * `POST /subscription/quote` passes the panel's `activeAddOns` — the live
 * add-ons an upgrade keeps, each with the end it will have — to the review,
 * entry by entry and all or nothing.
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
    paidRemainderDays: 0,
    ...extra,
  };
}

const DEVICES = { type: "EXTRA_DEVICES", value: 2, expiresAt: "2026-10-12T09:30:00.000Z" };
const TRAFFIC = { type: "EXTRA_TRAFFIC", value: 50, expiresAt: "2026-11-01T00:00:00.000Z" };

describe("subscription quote route: the live add-ons an upgrade keeps", () => {
  it("passes each one with its end to the review", async () => {
    const flat = await quote(panelQuote({ activeAddOns: [DEVICES, TRAFFIC] }));

    expect(flat.activeAddOns).toEqual([DEVICES, TRAFFIC]);
    expect(flat.finalPrice).toBe(650);
    expect(flat.warning).toBeUndefined();
  });

  it("passes an end of null: until the subscription ends", async () => {
    const lifetime = { type: "EXTRA_DEVICES", value: 1, expiresAt: null };
    const flat = await quote(panelQuote({ activeAddOns: [lifetime] }));

    expect(flat.activeAddOns).toEqual([lifetime]);
  });

  it("re-states the entries: nothing the panel adds beside the three fields reaches the review", async () => {
    const flat = await quote(panelQuote({ activeAddOns: [{ ...DEVICES, id: "ent-1", termId: "term-9" }] }));

    expect(flat.activeAddOns).toEqual([DEVICES]);
  });

  it("adds nothing for a panel older than the field, none to list, or an empty list", async () => {
    expect(await quote(panelQuote())).not.toHaveProperty("activeAddOns");
    expect(await quote(panelQuote({ activeAddOns: null }))).not.toHaveProperty("activeAddOns");
    expect(await quote(panelQuote({ activeAddOns: [] }))).not.toHaveProperty("activeAddOns");
  });

  it("drops the whole list when one entry is malformed, rather than leave that add-on out of it", async () => {
    const malformedEntries: unknown[] = [
      null,
      "EXTRA_DEVICES",
      { ...DEVICES, type: "RESET_TRAFFIC" },
      { ...DEVICES, type: "extra_devices" },
      { ...DEVICES, value: 0 },
      { ...DEVICES, value: -2 },
      { ...DEVICES, value: 1.5 },
      { ...DEVICES, value: "2" },
      { ...DEVICES, value: 1e20 },
      { ...DEVICES, expiresAt: "12.10.2026" },
      { ...DEVICES, expiresAt: "2026-10-12" },
      { ...DEVICES, expiresAt: "2026-13-45T00:00:00.000Z" },
      { ...DEVICES, expiresAt: 1_760_000_000_000 },
      { type: "EXTRA_DEVICES", value: 2 },
    ];
    for (const malformed of malformedEntries) {
      const flat = await quote(panelQuote({ activeAddOns: [TRAFFIC, malformed] }));
      expect(flat, JSON.stringify(malformed)).not.toHaveProperty("activeAddOns");
      expect(flat.finalPrice, "the quote itself is untouched").toBe(650);
    }
  });

  it("drops anything but a list, and a list longer than any subscription holds", async () => {
    for (const malformed of [DEVICES, "list", 3, { 0: DEVICES }]) {
      expect(await quote(panelQuote({ activeAddOns: malformed })), JSON.stringify(malformed)).not.toHaveProperty(
        "activeAddOns",
      );
    }
    const tooMany = Array.from({ length: 51 }, () => DEVICES);
    expect(await quote(panelQuote({ activeAddOns: tooMany }))).not.toHaveProperty("activeAddOns");
    const fifty = Array.from({ length: 50 }, () => DEVICES);
    expect((await quote(panelQuote({ activeAddOns: fifty }))).activeAddOns).toHaveLength(50);
  });

  it("keeps «Сверх тарифа» and the paid remainder beside it, each as the panel sent it", async () => {
    const carried = { deviceLimit: 1, trafficLimitGb: 0, unlimitedDevices: false, unlimitedTraffic: false };
    const flat = await quote(panelQuote({ paidRemainderDays: 6, carriedAbovePlan: carried, activeAddOns: [DEVICES] }));

    expect(flat.paidRemainderDays).toBe(6);
    expect(flat.carriedAbovePlan).toEqual(carried);
    expect(flat.activeAddOns).toEqual([DEVICES]);
  });

  it("says nothing of add-ons on a quote the panel could not price", async () => {
    const flat = await quote({
      selectedPlan: null,
      price: null,
      warnings: [{ code: "PLAN_NOT_AVAILABLE" }],
      activeAddOns: [DEVICES],
    });

    expect(flat.warning).toBe("PLAN_NOT_AVAILABLE");
    expect(flat).not.toHaveProperty("activeAddOns");
  });
});
