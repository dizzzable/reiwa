// @vitest-environment jsdom

/**
 * The service worker could pin a network failure in place for 30 days.
 *
 * Its static-asset route matched `request.destination === 'script'` with no
 * origin test, and served it `CacheFirst` with a 30-day expiry and
 * `CacheableResponsePlugin({ statuses: [0, 200] })`. That captured
 * `telegram.org/js/telegram-web-app.js` — and status 0 means an opaque
 * cross-origin response is cacheable too, so a DPI or ISP interception page
 * returned as 200 was stored and replayed through every subsequent redeploy.
 * The one host these users cannot reach was also the one whose failure the app
 * remembered longest.
 *
 * This drives the real routing table: the module is imported with Workbox
 * stubbed, and the matchers it registers are then asked directly.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

type RouteMatcher = (options: { request: unknown; url: URL }) => boolean;

interface CapturedRoute {
  readonly match: RouteMatcher;
  readonly strategyName: string;
  readonly cacheName: string;
}

const captured = vi.hoisted(() => ({ routes: [] as unknown[] }));

vi.mock("workbox-precaching", () => ({
  // Split since the precache ROUTE is registered after the navigation route
  // (see `service-worker-navigation-precedence.test.tsx`); this file only
  // needs both halves to exist so `sw.ts` imports cleanly.
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
      readonly cacheName: string;
      constructor(options: { readonly cacheName?: string }) {
        this.cacheName = options?.cacheName ?? "";
      }
    };
  return {
    CacheFirst: strategy("CacheFirst"),
    NetworkFirst: strategy("NetworkFirst"),
    StaleWhileRevalidate: strategy("StaleWhileRevalidate"),
  };
});

vi.mock("workbox-expiration", () => ({ ExpirationPlugin: class {} }));
vi.mock("workbox-cacheable-response", () => ({ CacheableResponsePlugin: class {} }));

const TELEGRAM_SDK = "https://telegram.org/js/telegram-web-app.js";
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/** A subresource fetch, as Workbox hands it to a route matcher. */
function fetchOf(href: string, destination: string): { request: unknown; url: URL } {
  return {
    request: { destination, mode: "no-cors", method: "GET" },
    url: new URL(href),
  };
}

let routes: CapturedRoute[] = [];

beforeAll(async () => {
  await import("../src/sw");
  routes = captured.routes.map((route) => {
    const registered = route as {
      readonly match: RouteMatcher;
      readonly handler: { readonly strategyName: string; readonly cacheName: string };
    };
    return {
      match: registered.match,
      strategyName: registered.handler.strategyName,
      cacheName: registered.handler.cacheName,
    };
  });
});

function cacheFirstRoutes(): CapturedRoute[] {
  return routes.filter((route) => route.strategyName === "CacheFirst");
}

describe("service worker static-asset route", () => {
  it("registers a cache-first route at all", () => {
    // Guards the rest of this file: a stubbed-out import that registered
    // nothing would make every "does not match" assertion below vacuous.
    expect(cacheFirstRoutes()).toHaveLength(1);
  });

  it("never cache-firsts a cross-origin script", () => {
    for (const route of cacheFirstRoutes()) {
      expect(route.match(fetchOf(TELEGRAM_SDK, "script"))).toBe(false);
      expect(route.match(fetchOf(TURNSTILE, "script"))).toBe(false);
    }
  });

  it("leaves no route willing to persist a third-party asset", () => {
    // Not only the cache-first one: an interception page stored by any route
    // outlives the fetch that produced it.
    for (const route of routes) {
      expect(route.match(fetchOf(TELEGRAM_SDK, "script"))).toBe(false);
      expect(route.match(fetchOf("https://cdn.example/logo.png", "image"))).toBe(false);
      expect(route.match(fetchOf("https://cdn.example/theme.css", "style"))).toBe(false);
    }
  });

  it("still cache-firsts our own fingerprinted bundles", () => {
    const [staticRoute] = cacheFirstRoutes();
    const origin = self.location.origin;

    expect(staticRoute.match(fetchOf(`${origin}/assets/index-a1b2c3.js`, "script"))).toBe(true);
    expect(staticRoute.match(fetchOf(`${origin}/assets/index-a1b2c3.css`, "style"))).toBe(true);
    expect(staticRoute.match(fetchOf(`${origin}/icons/icon-192x192.png`, "image"))).toBe(true);
  });

  it("never cache-firsts an operator-uploaded asset", () => {
    // The route's ONLY justification is stated above it: "Vite fingerprints the
    // filename, so the bytes behind a URL never change". Everything under
    // `/uploads/` is the one same-origin family that is not ours and not
    // fingerprinted — it is proxied straight off the operator panel, and the
    // operator edits it from a form, on a schedule that has nothing to do with
    // a redeploy.
    //
    // The branding icon is the case that hurts. `GET /uploads/branding/<file>`
    // answers a 302 to `/icons/icon-512x512.png` — the STOCK REIWA ICON —
    // whenever the panel is unreachable and the disk mirror is cold
    // (`src/api/app.ts`, the branding proxy). CacheFirst stores that followed
    // 200 under the operator's own icon URL for 30 days, so one restart of the
    // panel at the wrong moment replaces the operator's brand with Reiwa's for
    // a month, on a device the operator cannot reach: evicting the server-side
    // mirror through `reiwa.branding.invalidate` does not touch CacheStorage in
    // somebody else's browser.
    const origin = self.location.origin;

    for (const route of cacheFirstRoutes()) {
      expect(
        route.match(fetchOf(`${origin}/uploads/branding/9f8e7d.png`, "image")),
        "the operator's PWA icon is pinned for 30 days — a stock-Reiwa fallback served during one panel outage outlives the outage by a month",
      ).toBe(false);
      expect(route.match(fetchOf(`${origin}/uploads/icons/plan-pro.png`, "image"))).toBe(false);
      expect(route.match(fetchOf(`${origin}/uploads/emoji/wave.png`, "image"))).toBe(false);
    }
  });

  it("renames the static cache so an already-poisoned generation is purged", () => {
    // The `activate` handler deletes every `static-assets-*` cache that is not
    // the current one, so the rename IS the cleanup for clients that already
    // stored an interception page under v2. Without it the fix would ship and
    // the poisoned entry would keep being served.
    const [staticRoute] = cacheFirstRoutes();

    expect(staticRoute.cacheName).toMatch(/^static-assets-v\d+$/);
    expect(staticRoute.cacheName).not.toBe("static-assets-v2");
    // Same argument, one generation later: v3 is the generation that stored
    // `/uploads/**`, so shipping the exclusion above without renaming would fix
    // new entries while every already-pinned stock icon kept being served.
    expect(
      staticRoute.cacheName,
      "the /uploads exclusion ships, but the generation holding the already-pinned entries is never dropped",
    ).not.toBe("static-assets-v3");
  });
});
