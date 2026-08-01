import { describe, expect, it } from "vitest";

import {
  canPreloadNavigationRoutes,
  isNavigationRoutePreloadable,
} from "../src/components/layout/navigation-preload";

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

  it("does not spend an opted-in or slow mobile connection on optional chunks", () => {
    expect(canPreloadNavigationRoutes()).toBe(true);
    expect(canPreloadNavigationRoutes({ saveData: true })).toBe(false);
    expect(canPreloadNavigationRoutes({ effectiveType: "slow-2g" })).toBe(false);
    expect(canPreloadNavigationRoutes({ effectiveType: "2g" })).toBe(false);
    expect(canPreloadNavigationRoutes({ effectiveType: "3g" })).toBe(true);
  });
});
