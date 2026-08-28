// @vitest-environment jsdom

/**
 * Every cabinet route belongs to exactly one nav tab
 * ═══════════════════════════════════════════════════
 * `useNavTabs` lets the operator hide primary destinations. A hidden one stays
 * reachable, so its routes are folded into a visible tab's `matchPrefix` —
 * otherwise `resolveActiveTabTo` returns null and neither the bottom nav nor
 * the desktop sidebar highlights anything while the user is standing on that
 * screen.
 *
 * `referrals` had no fold. It is also the only POLYMORPHIC destination — the
 * same slot renders `/partner` for an active partner and `/referrals` for
 * everyone else — so it owns one of its two routes at a time and orphans the
 * other, hidden or not.
 *
 * That combination is why this file pins the RULE and not the route. The fold
 * list is five easy-to-forget lines next to a nine-entry registry; the next
 * destination added will be forgotten the same way. So the table below is typed
 * `Record<NavDestinationId, …>` — adding a destination without listing its
 * routes fails to compile — and the sweep asserts every route resolves to some
 * tab in both partner states.
 *
 * Each "resolves to Settings" assertion is paired with a positive control that
 * the same route resolves to its OWN tab when the destination is visible. A
 * `resolveActiveTabTo` that returned `/settings` for everything would otherwise
 * satisfy the whole sweep.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NAV_DESTINATIONS, type NavDestinationId, type NavItemSetting } from "@/types/branding";
import { DEVICE_NAV_ROUTE } from "@/components/layout/nav-config";

const state = vi.hoisted(() => ({
  navItems: [] as NavItemSetting[],
  partnerActive: false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-partner-status", () => ({
  usePartnerStatus: () => ({ status: { isActive: state.partnerActive }, isLoading: false }),
}));
vi.mock("@/hooks/use-support-unread", () => ({ useSupportUnread: () => 0 }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { navItems: state.navItems } }),
}));

import { resolveActiveTabTo, useNavTabs, type NavTab } from "@/components/layout/use-nav-tabs";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

/**
 * Canonical routes each destination owns.
 *
 * Typed against `NavDestinationId`, so a tenth destination cannot be added to
 * `NAV_DESTINATIONS` without someone answering "and which routes does it own".
 * That question is the one the referrals fold never got asked.
 */
const ROUTES: Record<NavDestinationId, readonly string[]> = {
  subscriptions: ["/dashboard", "/subscription"],
  plans: ["/plans", "/purchase"],
  // BOTH, on purpose — see the header.
  referrals: ["/referrals", "/partner"],
  devices: [DEVICE_NAV_ROUTE],
  activity: ["/activity"],
  promo: ["/promo"],
  support: ["/support"],
  faq: ["/settings/faq"],
  settings: ["/settings"],
};

const mounted: Root[] = [];

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  state.navItems = [];
  state.partnerActive = false;
});

function tabsFor(navItems: NavItemSetting[], partnerActive: boolean): readonly NavTab[] {
  state.navItems = navItems;
  state.partnerActive = partnerActive;

  let captured: readonly NavTab[] = [];
  function Probe(): null {
    captured = useNavTabs();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  mounted.push(root);
  act(() => root.render(<Probe />));
  return captured;
}

/** Everything hideable, hidden. `subscriptions` / `settings` are forced back. */
const ALL_HIDDEN: NavItemSetting[] = NAV_DESTINATIONS.map((id) => ({ id, visible: false }));

describe("nav route ownership", () => {
  for (const partnerActive of [false, true]) {
    const who = partnerActive ? "an active partner" : "an ordinary user";

    it(`leaves no route without an active tab when every destination is hidden — ${who}`, () => {
      const tabs = tabsFor(ALL_HIDDEN, partnerActive);
      // Positive control: hiding everything leaves the two essentials, so the
      // sweep below is about folding and not about an empty tab list matching
      // nothing at all.
      expect(tabs.map((tab) => tab.to)).toStrictEqual(["/dashboard", "/settings"]);

      const orphans = Object.values(ROUTES)
        .flat()
        .filter((route) => resolveActiveTabTo(tabs, route) === null);
      // Named, not counted: a failure should say which screen shows a dead nav.
      expect(orphans).toStrictEqual([]);
    });
  }

  it("folds both referral routes into Settings when the destination is hidden", () => {
    const tabs = tabsFor(ALL_HIDDEN, false);
    expect(resolveActiveTabTo(tabs, "/referrals")).toBe("/settings");
    expect(resolveActiveTabTo(tabs, "/partner")).toBe("/settings");
  });

  it("gives the referral routes their own tab when the destination is visible", () => {
    // The positive control for the two assertions above: without it, a
    // `resolveActiveTabTo` that answered `/settings` for every input would pass.
    const asUser = tabsFor([{ id: "referrals", visible: true }], false);
    expect(resolveActiveTabTo(asUser, "/referrals")).toBe("/referrals");

    const asPartner = tabsFor([{ id: "referrals", visible: true }], true);
    expect(resolveActiveTabTo(asPartner, "/partner")).toBe("/partner");
  });

  it("still owns the variant the user is not on", () => {
    // The polymorphic half. A partner reaches `/referrals` by direct link more
    // often than it looks — the points exchange lives there and the partner hub
    // does not link to it — and a non-partner can land on `/partner` from an
    // old link.
    const asPartner = tabsFor([{ id: "referrals", visible: true }], true);
    expect(resolveActiveTabTo(asPartner, "/referrals")).toBe("/settings");

    const asUser = tabsFor([{ id: "referrals", visible: true }], false);
    expect(resolveActiveTabTo(asUser, "/partner")).toBe("/settings");
  });

  it("keeps the FAQ tab winning over Settings on its nested route", () => {
    // `/settings/faq` matches both prefixes; longest wins. Pinned because the
    // fold list grows by pushing MORE prefixes onto Settings, and this is the
    // one route where that could start stealing another tab's highlight.
    const tabs = tabsFor([{ id: "faq", visible: true }], false);
    expect(resolveActiveTabTo(tabs, "/settings/faq")).toBe("/settings/faq");
    expect(resolveActiveTabTo(tabs, "/settings")).toBe("/settings");
  });
});
