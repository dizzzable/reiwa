// @vitest-environment jsdom

/**
 * A read that carries a settings version reaches the network, and the worker
 * keeps ONE copy of each path whatever the version.
 *
 * The page's version watcher (`lib/config-versions.ts`) puts `?v=<version>` on
 * a read once the cabinet has moved to a new version of a settings group. The
 * worker keeps `/api/v1/landing` (and `/branding`, `/gateways`) stale-while-
 * revalidate for a day, which answers from the cache FIRST — the very copy the
 * watcher is replacing. So a versioned read goes to the network first, and its
 * answer is stored under the path without the version: the entry a plain read
 * (the next visit's first load) is served from is refreshed, and the cache does
 * not grow one entry per version the operator ever saved.
 *
 * Driven through the real routing table, like the other service-worker specs:
 * the module is imported with Workbox stubbed, and the first route that claims
 * a request is the one asked, because Workbox answers with the first match.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

type RouteMatcher = (options: { request: unknown; url: URL }) => boolean;

interface CacheKeyPlugin {
  readonly cacheKeyWillBeUsed?: (options: { request: { url: string }; mode: string }) => Promise<string | { url: string }>;
}

interface StrategyOptions {
  readonly cacheName?: string;
  readonly plugins?: readonly CacheKeyPlugin[];
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

function url(path: string): URL {
  return new URL(`${self.location.origin}${path}`);
}

/** The route Workbox would actually use: the first registered one that matches. */
function answeringRoute(path: string, method = "GET"): CapturedRoute | undefined {
  const request = { request: { method, mode: "cors", destination: "" }, url: url(path) };
  return routes.find((route) => route.match(request));
}

/** The key the route's plugins store and look up a response under. */
async function cacheKeyOf(route: CapturedRoute | undefined, path: string): Promise<string> {
  let key: string = url(path).href;
  for (const plugin of route?.options.plugins ?? []) {
    if (plugin.cacheKeyWillBeUsed === undefined) continue;
    const next = await plugin.cacheKeyWillBeUsed({ request: { url: key }, mode: "write" });
    key = typeof next === "string" ? next : next.url;
  }
  return key;
}

describe("service worker and versioned settings reads", () => {
  it("sends a versioned read to the network first", () => {
    const versioned = answeringRoute("/api/v1/landing?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(versioned?.strategyName).toBe("NetworkFirst");
    // Non-vacuity: the plain read of the same path is still served from the
    // cache first, so the difference is the version and nothing else.
    expect(answeringRoute("/api/v1/landing")?.strategyName).toBe("StaleWhileRevalidate");
  });

  it("keeps every version of a path under ONE key — the one a plain read uses", async () => {
    const versioned = answeringRoute("/api/v1/landing?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const plain = answeringRoute("/api/v1/landing");
    expect(versioned?.options.cacheName).toBe(plain?.options.cacheName);

    const canonical = url("/api/v1/landing").href;
    expect(await cacheKeyOf(versioned, "/api/v1/landing?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(canonical);
    expect(await cacheKeyOf(versioned, "/api/v1/landing?v=cccccccccccccccccccccccccccccccc")).toBe(canonical);
    expect(await cacheKeyOf(plain, "/api/v1/landing")).toBe(canonical);
  });

  it("strips only the version from the key", async () => {
    const route = answeringRoute("/api/v1/gateways?v=b&currency=RUB");
    expect(await cacheKeyOf(route, "/api/v1/gateways?v=b&currency=RUB")).toBe(url("/api/v1/gateways?currency=RUB").href);
  });

  it("does not start caching a path just because it carries a version", () => {
    expect(answeringRoute("/api/v1/public-config?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    expect(answeringRoute("/api/v1/platform-policy?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    expect(answeringRoute("/api/v1/landing?v=b", "POST")).toBeUndefined();
  });
});
