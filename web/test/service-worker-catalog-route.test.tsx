// @vitest-environment jsdom

/**
 * The plan catalogue is not the service worker's to keep.
 *
 * `/api/v1/plans` is resolved by the panel FOR THE SIGNED-IN SUBSCRIBER: plans
 * offered only to them, prices after their personal discounts. The worker kept
 * it under the one URL — first stale-while-revalidate, then network-first with
 * a five-second fallback — so on a slow or absent network the next account
 * signed in on the same browser was shown the previous account's catalogue.
 * The cabinet cannot buy offline anyway; the catalogue now always comes from
 * the network, and the cache generation that stored it is purged.
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

describe("service worker and the plan catalogue", () => {
  it("routes the plan catalogue past every cache, straight to the network", () => {
    // Non-vacuity: the table did load, and it does route the neighbours.
    expect(answeringRoute("/api/v1/branding")).toBeDefined();
    expect(
      answeringRoute("/api/v1/plans")?.strategyName,
      "a signed-in subscriber's catalogue is stored where the next account can be served it",
    ).toBeUndefined();
  });

  it("moves the API cache past the generation that stored catalogues, so installed workers purge them", () => {
    // `activate` deletes every `api-responses-*` generation that is not the
    // current one; v4 is the last generation that held `/api/v1/plans`.
    const cacheName = answeringRoute("/api/v1/branding")?.options.cacheName ?? "";
    const generation = /^api-responses-v(\d+)$/.exec(cacheName)?.[1];

    expect(generation, `unexpected API cache name "${cacheName}"`).toBeDefined();
    expect(Number(generation)).toBeGreaterThan(4);
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
