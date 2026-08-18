// @vitest-environment jsdom

/**
 * The precache route was quietly overriding the network-first navigation rule.
 *
 * `sw.ts` states in capitals that HTML navigations MUST be network-first, and
 * registers a `NetworkFirst` route for `request.mode === 'navigate'`. But it
 * also called `precacheAndRoute()` — which is `precache()` + `addRoute()` — one
 * screen ABOVE that. Workbox's router answers with the FIRST registered route
 * whose matcher accepts the request, and `PrecacheRoute` resolves a request for
 * `/` to the precached `index.html` through its `directoryIndex` default. So
 * the entry document, alone among all navigations, was served cache-first from
 * the build-time precache.
 *
 * That is invisible to a strategy-by-strategy test: every route was configured
 * exactly as intended, and the one that answered `/` was never asked. Only the
 * ORDER tells you, so order is what this file asserts — together with proof
 * that both routes exist at all, since "no precache route was registered"
 * would satisfy an order assertion vacuously.
 *
 * It matters beyond stale bundles now: the API injects the operator's PWA icon
 * and app title into the served `index.html`, and a cache-first `/` handed
 * returning visitors the build-time head — stock icon included — until the next
 * deploy replaced the precache.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

type RouteMatcher = (options: { request: unknown; url: URL }) => boolean;

interface Registration {
  readonly kind: "precache" | "route";
  readonly match?: RouteMatcher;
  readonly strategyName?: string;
  readonly cacheName?: string;
}

const captured = vi.hoisted(() => ({ registrations: [] as Registration[] }));

vi.mock("workbox-precaching", () => ({
  // Installing the shell is untouched; only the route registration moved.
  precache: () => undefined,
  addRoute: () => {
    captured.registrations.push({ kind: "precache" });
  },
  // The old one-liner stays mocked deliberately. A revert to it must fail the
  // ordering assertion below with a readable message rather than blowing up as
  // an unresolved module export.
  precacheAndRoute: () => {
    captured.registrations.push({ kind: "precache" });
  },
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
    const registered = route as {
      readonly match: RouteMatcher;
      readonly handler: { readonly strategyName: string; readonly cacheName: string };
    };
    captured.registrations.push({
      kind: "route",
      match: registered.match,
      strategyName: registered.handler.strategyName,
      cacheName: registered.handler.cacheName,
    });
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

let registrations: Registration[] = [];

beforeAll(async () => {
  await import("../src/sw");
  registrations = captured.registrations;
});

function navigationRouteIndex(): number {
  return registrations.findIndex(
    (entry) =>
      entry.kind === "route" &&
      entry.strategyName === "NetworkFirst" &&
      (entry.cacheName ?? "").startsWith("navigations-"),
  );
}

function precacheRouteIndex(): number {
  return registrations.findIndex((entry) => entry.kind === "precache");
}

describe("service worker navigation precedence", () => {
  it("registers both a precache route and a network-first navigation route", () => {
    // Non-vacuity guard for the ordering assertion below: with either side
    // missing, "before" would hold for the wrong reason.
    expect(precacheRouteIndex()).toBeGreaterThan(-1);
    expect(navigationRouteIndex()).toBeGreaterThan(-1);
  });

  it("lets the navigation route claim a request before the precache route can", () => {
    expect(navigationRouteIndex()).toBeLessThan(precacheRouteIndex());
  });

  it("claims the entry document, which is the URL the precache route resolves", () => {
    const navigation = registrations[navigationRouteIndex()];
    const root = { request: { mode: "navigate" }, url: new URL(`${self.location.origin}/`) };

    expect(navigation?.match?.(root)).toBe(true);
  });

  it("leaves subresources to the routes registered after it", () => {
    const navigation = registrations[navigationRouteIndex()];
    const bundle = {
      request: { mode: "no-cors", destination: "script" },
      url: new URL(`${self.location.origin}/assets/index-a1b2c3.js`),
    };

    expect(navigation?.match?.(bundle)).toBe(false);
  });
});
