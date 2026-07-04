import { useMemo, type ComponentType, type SVGProps } from "react";
import {
  Activity,
  Bolt,
  CircleHelp,
  Handshake,
  LifeBuoy,
  MonitorSmartphone,
  Tag,
  TicketPercent,
  UserPlus,
  WalletCards,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePartnerStatus } from "@/hooks/use-partner-status";
import { useSupportUnread } from "@/hooks/use-support-unread";
import { useBranding } from "@/lib/branding-provider";
import type { NavDestinationId, NavItemSetting } from "@/types/branding";

export interface NavTab {
  readonly to: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly label: string;
  readonly testId: string;
  /** When the route prefix matches we treat this tab as active. */
  readonly matchPrefix: readonly string[];
  /** Optional unread-count badge (e.g. support replies on the Support tab). */
  readonly badge?: number;
}

/** Fallback nav when the operator config is absent (legacy payloads). */
const DEFAULT_NAV: readonly NavItemSetting[] = [
  { id: "subscriptions", visible: true },
  { id: "referrals", visible: true },
  { id: "settings", visible: true },
];

/**
 * Primary cabinet destinations, shared by the mobile `BottomNav` and the
 * desktop `SideNav`. The set + order are operator-configurable via WEB Reiwa
 * (`branding.navItems`): each destination can be surfaced or hidden, with
 * `subscriptions` + `settings` always present. Hidden destinations stay
 * reachable from Settings, so their routes fold into the Settings tab's match
 * prefixes (and the buy funnel folds into Subscriptions) to keep exactly one
 * active tab per route.
 */
export function useNavTabs(): readonly NavTab[] {
  const { t } = useTranslation();
  const { status: partner } = usePartnerStatus();
  const { branding } = useBranding();
  const supportUnread = useSupportUnread();

  return useMemo<readonly NavTab[]>(() => {
    const items =
      branding.navItems && branding.navItems.length > 0 ? branding.navItems : DEFAULT_NAV;

    const visible = new Set<NavDestinationId>(
      items.filter((i) => i.visible).map((i) => i.id),
    );
    // Essentials are never hideable.
    visible.add("subscriptions");
    visible.add("settings");

    // Fold hidden destinations' routes into a visible owner so the active
    // tab stays unambiguous (the buy funnel → Subscriptions; the rest →
    // Settings, where they remain reachable).
    const subsPrefix = ["/dashboard", "/subscription"];
    const settingsPrefix = ["/settings"];
    if (!visible.has("plans")) subsPrefix.push("/plans", "/purchase");
    if (!visible.has("devices")) subsPrefix.push("/devices");
    if (!visible.has("activity")) settingsPrefix.push("/activity");
    if (!visible.has("promo")) settingsPrefix.push("/promo");
    if (!visible.has("support")) settingsPrefix.push("/support");

    const registry: Record<NavDestinationId, NavTab> = {
      subscriptions: {
        to: "/dashboard",
        icon: WalletCards,
        label: t("bottomNav.subscriptions"),
        testId: "tab-subscriptions",
        matchPrefix: subsPrefix,
      },
      plans: {
        to: "/plans",
        icon: Tag,
        label: t("bottomNav.plans"),
        testId: "tab-plans",
        matchPrefix: ["/plans", "/purchase"],
      },
      referrals: partner.isActive
        ? {
            to: "/partner",
            icon: Handshake,
            label: t("bottomNav.partner"),
            testId: "tab-partner",
            matchPrefix: ["/partner"],
          }
        : {
            to: "/referrals",
            icon: UserPlus,
            label: t("bottomNav.referral"),
            testId: "tab-referral",
            matchPrefix: ["/referrals"],
          },
      devices: {
        to: "/devices",
        icon: MonitorSmartphone,
        label: t("bottomNav.devices"),
        testId: "tab-devices",
        matchPrefix: ["/devices"],
      },
      activity: {
        to: "/activity",
        icon: Activity,
        label: t("bottomNav.activity"),
        testId: "tab-activity",
        matchPrefix: ["/activity"],
      },
      promo: {
        to: "/promo",
        icon: TicketPercent,
        label: t("bottomNav.promo"),
        testId: "tab-promo",
        matchPrefix: ["/promo"],
      },
      support: {
        to: "/support",
        icon: LifeBuoy,
        label: t("bottomNav.support"),
        testId: "tab-support",
        matchPrefix: ["/support"],
        badge: supportUnread,
      },
      settings: {
        to: "/settings",
        icon: Bolt,
        label: t("bottomNav.settings"),
        testId: "tab-settings",
        matchPrefix: settingsPrefix,
      },
      faq: {
        to: "/settings/faq",
        icon: CircleHelp,
        label: t("bottomNav.faq"),
        testId: "tab-faq",
        matchPrefix: ["/settings/faq"],
      },
    };

    const seen = new Set<NavDestinationId>();
    const tabs: NavTab[] = [];
    for (const item of items) {
      if (!visible.has(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      tabs.push(registry[item.id]);
    }
    // Guarantee essentials are present even if the config omitted them.
    if (!seen.has("subscriptions")) tabs.unshift(registry.subscriptions);
    if (!seen.has("settings")) tabs.push(registry.settings);
    return tabs;
  }, [partner.isActive, t, branding.navItems, supportUnread]);
}

/**
 * Whether the operator surfaced "Support" as a visible bottom-nav destination.
 * Drives where the unread-support indicator lives: when Support is in the nav
 * it carries its own badge and the header bell stops counting support replies;
 * when it isn't, the bell keeps surfacing them (legacy behaviour). Essentials
 * (`subscriptions`/`settings`) are irrelevant here — Support is opt-in.
 */
export function useSupportInNav(): boolean {
  const { branding } = useBranding();
  const items =
    branding.navItems && branding.navItems.length > 0 ? branding.navItems : DEFAULT_NAV;
  return items.some((i) => i.id === "support" && i.visible);
}

/**
 * Resolves the single active tab's `to` by LONGEST matching prefix, so nested
 * routes win (e.g. `/settings/faq` → the FAQ tab, not the `/settings` tab).
 * Returns `null` when nothing matches.
 */
export function resolveActiveTabTo(
  tabs: readonly NavTab[],
  pathname: string,
): string | null {
  let bestTo: string | null = null;
  let bestLen = -1;
  for (const tab of tabs) {
    for (const prefix of tab.matchPrefix) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (prefix.length > bestLen) {
          bestLen = prefix.length;
          bestTo = tab.to;
        }
      }
    }
  }
  return bestTo;
}
