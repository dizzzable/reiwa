import { useMemo, type ComponentType, type SVGProps } from "react";
import { Bolt, Handshake, UserPlus, WalletCards } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePartnerStatus } from "@/hooks/use-partner-status";

export interface NavTab {
  readonly to: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly label: string;
  readonly testId: string;
  /** When the route prefix matches we treat this tab as active. */
  readonly matchPrefix: readonly string[];
}

/**
 * Primary cabinet destinations, shared by the mobile `BottomNav` and the
 * desktop `SideNav` so both stay in lockstep. The third tab swaps between
 * Referral and Partner once partner activation flips on.
 */
export function useNavTabs(): readonly NavTab[] {
  const { t } = useTranslation();
  const { status: partner } = usePartnerStatus();

  return useMemo<readonly NavTab[]>(() => {
    const referralTab: NavTab = partner.isActive
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
        };
    return [
      {
        to: "/dashboard",
        icon: WalletCards,
        label: t("bottomNav.subscriptions"),
        testId: "tab-subscriptions",
        matchPrefix: ["/dashboard", "/subscription", "/plans", "/purchase"],
      },
      referralTab,
      {
        to: "/settings",
        icon: Bolt,
        label: t("bottomNav.settings"),
        testId: "tab-settings",
        matchPrefix: ["/settings", "/activity", "/promo", "/support"],
      },
    ] as const;
  }, [partner.isActive, t]);
}

/** True when `pathname` falls under any of the tab's match prefixes. */
export function isTabActive(tab: NavTab, pathname: string): boolean {
  return tab.matchPrefix.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
