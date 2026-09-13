// @vitest-environment jsdom

/**
 * The plan catalogue must reach a subscriber when it changes, not a visit later.
 *
 * `/api/v1/plans` was served stale-while-revalidate for up to 24 hours. That
 * strategy ANSWERS FROM THE CACHE and only refreshes it behind the response, so
 * the first catalogue a returning subscriber saw after an operator archived or
 * deleted a plan was always the old one — withdrawn plan included — and React
 * Query then held that copy for its own five minutes. Worse, the cabinet's
 * recovery after the panel refuses such a plan is to refetch the catalogue, and
 * that refetch was answered from the same cache: it could hand the dead plan
 * straight back.
 *
 * Driven through the real routing table, like the other service-worker specs:
 * the module is imported with Workbox stubbed, and the first route that claims
 * a request is the one asked, because Workbox answers with the first match.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

type RouteMatcher = (options: { request: unknown; url: URL }) => boolean;

interface StrategyOptions {
  readonly cacheName?: string;
  readonly networkTimeoutSeconds?: number;
}

interface CapturedRoute {
  readonly match: RouteMatcher;
  readonly strategyName: string;
  readonly options: StrategyOptions;
}

const captured = vi.hoisted(() => ({ routes: [] as unknown[] }));

vi.mock("workbox-precaching", () => ({
  precache: () => undefined,
  addRoute: () => undefined,
  cleanupOutdatedCaches: () => undefined,
}));

vi.mock("workbox-routing", () => ({
  Route: class {
    constructor(
      readonly match: unknown,
      readonly handler: unknown,
    ) {}
  },
  registerRoute: (route: unknown) => {
    captured.routes.push(route);
  },
  setCatchHandler: () => undefined,
}));

vi.mock("workbox-strategies", () => {
  const strategy = (strategyName: string) =>
    class {
      readonly strategyName = strategyName;
      constructor(readonly options: StrategyOptions = {}) {}
    };
  return {
    CacheFirst: strategy("CacheFirst"),
    NetworkFirst: strategy("NetworkFirst"),
    StaleWhileRevalidate: strategy("StaleWhileRevalidate"),
  };
});

vi.mock("workbox-expiration", () => ({ ExpirationPlugin: class {} }));
vi.mock("workbox-cacheable-response", () => ({ CacheableResponsePlugin: class {} }));

let routes: CapturedRoute[] = [];

beforeAll(async () => {
  await import("../src/sw");
  routes = captured.routes.map((route) => {
    const registered = route as {
      readonly match: RouteMatcher;
      readonly handler: { readonly strategyName: string; readonly options: StrategyOptions };
    };
    return {
      match: registered.match,
      strategyName: registered.handler.strategyName,
      options: registered.handler.options,
    };
  });
});

/** An API read from the SPA, as Workbox hands it to a route matcher. */
function apiRequest(path: string, method = "GET"): { request: unknown; url: URL } {
  return {
    request: { method, mode: "cors", destination: "" },
    url: new URL(`${self.location.origin}${path}`),
  };
}

/** The route Workbox would actually use: the first registered one that matches. */
function answeringRoute(path: string, method = "GET"): CapturedRoute | undefined {
  const request = apiRequest(path, method);
  return routes.find((route) => route.match(request));
}

describe("service worker plan catalogue route", () => {
  it("asks the network before the cache for the plan catalogue", () => {
    expect(
      answeringRoute("/api/v1/plans")?.strategyName,
      "a withdrawn plan keeps being offered from the cache until the next visit",
    ).toBe("NetworkFirst");
  });

  it("still answers the catalogue from the API cache when the network does not", () => {
    // Offline and slow-network behaviour: NetworkFirst falls back to its cache
    // on failure or timeout, so the cache must be the owned API generation
    // (purged by `activate` on a bump) and the wait must be bounded.
    const route = answeringRoute("/api/v1/plans");

    expect(route?.options.cacheName).toMatch(/^api-responses-v\d+$/);
    expect(route?.options.networkTimeoutSeconds).toBeGreaterThan(0);
  });

  it("leaves the other public catalogues on stale-while-revalidate", () => {
    for (const path of ["/api/v1/branding", "/api/v1/gateways", "/api/v1/landing"]) {
      expect(answeringRoute(path)?.strategyName, path).toBe("StaleWhileRevalidate");
    }
  });

  it("never takes a write to the catalogue path", () => {
    expect(answeringRoute("/api/v1/plans", "POST")).toBeUndefined();
  });
});
