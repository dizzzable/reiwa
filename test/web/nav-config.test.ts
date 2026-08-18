import { describe, expect, it } from "vitest";

import {
  DEFAULT_NAV,
  DEVICE_NAV_ROUTE,
  normalizeNavItems,
} from "../../web/src/components/layout/nav-config.js";
import {
  DEFAULT_PUBLIC_CONFIG,
  type NavItemSetting,
} from "../../web/src/types/branding.js";

describe("WEB Reiwa navigation contract", () => {
  it("uses the actual nested devices route", () => {
    expect(DEVICE_NAV_ROUTE).toBe("/subscription/devices");
  });

  it("drops unknown and duplicate destinations and keeps at most five visible", () => {
    const normalized = normalizeNavItems(
      [
        { id: "plans", visible: true },
        { id: "plans", visible: true },
        { id: "unknown", visible: true },
        { id: "devices", visible: true },
        { id: "activity", visible: true },
        { id: "promo", visible: true },
        { id: "support", visible: true },
      ] as unknown as readonly NavItemSetting[],
    );

    expect(normalized.filter((item) => item.id === "plans")).toHaveLength(1);
    // `id` is narrowed to the known ids by then — which is the point of the
    // assertion, so widen for the comparison instead of weakening the type.
    expect(normalized.some((item) => (item.id as string) === "unknown")).toBe(false);
    expect(normalized.find((item) => item.id === "subscriptions")?.visible).toBe(true);
    expect(normalized.find((item) => item.id === "settings")?.visible).toBe(true);
    expect(normalized.filter((item) => item.visible)).toHaveLength(5);
  });

  it("renders exactly three tabs from the built-in identity, in the reported order", () => {
    // The countable half of the field report. A cabinet that lost its operator
    // configuration is not just off-palette — it is missing navigation the
    // operator switched on, and this is the assertion that ties the screenshot
    // to `DEFAULT_BRANDING` rather than to a theming bug. Both built-in
    // carriers have to agree, because either can reach `useNavTabs`:
    // `DEFAULT_NAV` when a payload arrives without `navItems`, and
    // `DEFAULT_PUBLIC_CONFIG.branding.navItems` when no payload arrives at all.
    const fromLegacyFallback = normalizeNavItems(DEFAULT_NAV)
      .filter((item) => item.visible)
      .map((item) => item.id);
    const fromBuiltInConfig = normalizeNavItems(
      DEFAULT_PUBLIC_CONFIG.branding.navItems!,
    )
      .filter((item) => item.visible)
      .map((item) => item.id);

    expect(fromLegacyFallback).toEqual(["subscriptions", "referrals", "settings"]);
    expect(fromBuiltInConfig).toEqual(["subscriptions", "referrals", "settings"]);
    // Support is the tab the operator added and the defaults do not carry.
    expect(fromBuiltInConfig).not.toContain("support");
  });
});
