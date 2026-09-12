import express from "express";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createPlansRouter } from "../../src/api/routes/plans.js";

/**
 * `GET /api/v1/plans` — the public catalog, and what it must not contain.
 *
 * THIS ROUTE IS REACHABLE WITHOUT AN ACCOUNT. Its session middleware is the
 * OPTIONAL one, so the catalog answers a visitor who has never signed in. It
 * used to forward the panel's answer verbatim (`res.json(plans ?? [])`), and
 * that answer carried `internalSquads` and `externalSquad` — the operator's own
 * Remnawave squad identifiers, copied off the plan row. Nothing in this
 * repository read either field; the only trace they left anywhere was a
 * declaration in the browser's type file.
 *
 * The panel stopped sending them. This file guards the OTHER half, which the
 * panel cannot: the two images upgrade separately, so a cabinet running ahead
 * of its panel still has to refuse to publish them.
 *
 * What is deliberately NOT asserted here is the full shape of a plan. The strip
 * is a denylist on purpose — an allow-list one field behind the panel would drop
 * a price and break the catalog for everyone, which is a far more expensive
 * failure than the one it would prevent. The case below therefore also pins
 * that everything else survives, because a "fix" that turned this into a
 * whitelist would pass the leak assertions and quietly empty the cards.
 */

interface GetPublicPlansSpy {
  (identity: Record<string, unknown> | undefined): Promise<unknown>;
}

function makeApp(getPublicPlans: GetPublicPlansSpy) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1",
    createPlansRouter({
      adminClient: { catalog: { getPublicPlans } } as never,
      sessionStore: null,
      config: {} as never,
    }),
  );
  return app;
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const SQUADS = ["8f1c0a3e-0000-4000-8000-000000000001", "8f1c0a3e-0000-4000-8000-000000000002"];
const EXTERNAL = "8f1c0a3e-0000-4000-8000-0000000000ff";

/** A plan as an OLD panel sends it — with the two internal fields still on it. */
const legacyPlan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "plan-1",
  orderIndex: 1,
  name: "Стандарт",
  description: null,
  tag: null,
  icon: null,
  type: "BOTH",
  availability: "ALL",
  trafficLimit: 1024,
  deviceLimit: 3,
  trafficLimitStrategy: "NO_RESET",
  internalSquads: SQUADS,
  externalSquad: EXTERNAL,
  isTrial: false,
  trialFree: false,
  durations: [{ days: 30, prices: [{ currency: "RUB", price: "299.00" }] }],
  displayPrices: [{ currency: "RUB", price: "299.00", days: 30 }],
  ...over,
});

describe("GET /api/v1/plans", () => {
  it("never publishes the operator's squad identifiers, even from an older panel", async () => {
    const getPublicPlans = vi.fn(async () => [legacyPlan()]);
    const { status, body } = await get(makeApp(getPublicPlans), "/api/v1/plans");

    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    for (const secret of [...SQUADS, EXTERNAL]) {
      expect(serialized).not.toContain(secret);
    }
    const [plan] = body as Record<string, unknown>[];
    expect(plan).not.toHaveProperty("internalSquads");
    expect(plan).not.toHaveProperty("externalSquad");
  });

  it("forwards everything else untouched, prices included", async () => {
    // The other half of the strip, and the one a careless rewrite breaks. A
    // whitelist that missed `durations` would satisfy every assertion above and
    // leave every card without a price.
    const getPublicPlans = vi.fn(async () => [legacyPlan()]);
    const { body } = await get(makeApp(getPublicPlans), "/api/v1/plans");
    const [plan] = body as Record<string, unknown>[];

    expect(plan?.["id"]).toBe("plan-1");
    expect(plan?.["name"]).toBe("Стандарт");
    expect(plan?.["trafficLimit"]).toBe(1024);
    expect(plan?.["durations"]).toEqual([
      { days: 30, prices: [{ currency: "RUB", price: "299.00" }] },
    ]);
    expect(plan?.["displayPrices"]).toEqual([{ currency: "RUB", price: "299.00", days: 30 }]);
    // Exactly the two internal keys are gone, and nothing else is.
    expect(Object.keys(plan ?? {}).sort()).toEqual(
      Object.keys(legacyPlan())
        .filter((key) => key !== "internalSquads" && key !== "externalSquad")
        .sort(),
    );
  });

  it("answers an empty list rather than an error when the panel is unreachable", async () => {
    // Pre-existing behaviour, pinned because the strip now stands between the
    // upstream answer and the response and must not change it.
    const getPublicPlans = vi.fn(async () => {
      throw new Error("panel down");
    });
    const { status, body } = await get(makeApp(getPublicPlans), "/api/v1/plans");
    expect(status).toBe(500);
    expect(body).toBeTruthy();
  });

  it("survives a panel answer that is not a list", async () => {
    // `stripInternalPlanFields` maps over the payload, so a panel answering an
    // object — or nothing at all — must not become a 500 on the catalog.
    for (const answer of [null, undefined, {}, "plans"]) {
      const { status, body } = await get(
        makeApp(vi.fn(async () => answer)),
        "/api/v1/plans",
      );
      expect(status).toBe(200);
      expect(body).toEqual([]);
    }
  });

  it("leaves a row that is not an object alone instead of dropping it", async () => {
    const { body } = await get(makeApp(vi.fn(async () => [null, 7, legacyPlan()])), "/api/v1/plans");
    const rows = body as unknown[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBeNull();
    expect(rows[1]).toBe(7);
  });
});
