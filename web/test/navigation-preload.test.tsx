import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isNavigationRoutePreloadable,
} from "../src/components/layout/navigation-preload";

const bottomNavSource = readFileSync(
  new URL("../src/components/layout/bottom-nav.tsx", import.meta.url),
  "utf8",
);
const sideNavSource = readFileSync(
  new URL("../src/components/layout/side-nav.tsx", import.meta.url),
  "utf8",
);

describe("navigation route preloading", () => {
  it("warms every primary cabinet destination that can be put in navigation", () => {
    for (const route of [
      "/dashboard",
      "/subscription/devices",
      "/partner",
      "/plans",
      "/activity",
      "/promo",
      "/referrals",
      "/settings",
      "/settings/faq",
      "/support",
    ]) {
      expect(isNavigationRoutePreloadable(route)).toBe(true);
    }
    expect(isNavigationRoutePreloadable("/renew")).toBe(false);
  });

  it("preloads only from a user's navigation intent, never from a launch timer", () => {
    for (const source of [bottomNavSource, sideNavSource]) {
      expect(source).toContain("onPointerDown={() => preloadNavigationRoute(tab.to)}");
      expect(source).toContain("onFocus={() => preloadNavigationRoute(tab.to)}");
      expect(source).not.toContain("useNavigationPreload(");
    }
  });
});
