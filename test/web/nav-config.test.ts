import { describe, expect, it } from "vitest";

import {
  DEVICE_NAV_ROUTE,
  normalizeNavItems,
} from "../../web/src/components/layout/nav-config.js";
import type { NavItemSetting } from "../../web/src/types/branding.js";

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
});
