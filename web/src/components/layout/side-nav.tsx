/**
 * SideNav (desktop)
 * ─────────────────
 * Persistent left sidebar shown on wide web viewports (see `useIsDesktop`).
 * Renders the same primary destinations as the mobile `BottomNav` but as a
 * vertical list with always-visible labels, plus a brand header and a couple
 * of quick actions (Buy / Promo). The active item is highlighted with a
 * brand-tinted pill that slides between entries (shared `layoutId`).
 *
 * The mobile BottomNav and this SideNav both consume `useNavTabs`, so the
 * destination set stays in lockstep across the two shells.
 */

import { motion } from "motion/react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding-provider";
import { ReiwaLogo } from "@/components/ui/reiwa-logo";
import { resolveActiveTabTo, useNavTabs, type NavTab } from "@/components/layout/use-nav-tabs";

export function SideNav() {
  const location = useLocation();
  const { t } = useTranslation();
  const { branding } = useBranding();
  const baseTabs = useNavTabs();

  const supportTab: NavTab = {
    to: "/support",
    icon: MessageSquare,
    label: t("bottomNav.support"),
    testId: "tab-support",
    matchPrefix: ["/support"],
  };
  // Desktop convenience: when the operator hasn't already surfaced Support as
  // its own nav destination, inject it before Settings (mobile keeps it under
  // Settings to save bottom-nav space). When Support IS a configured nav item
  // it's already in `baseTabs` (carrying its unread badge), so we must not add
  // it twice. The injected link intentionally has NO badge — for that case the
  // header bell still surfaces support replies, so we don't double-indicate.
  const hasSupport = baseTabs.some((tab) => tab.to === "/support");
  const tabs: readonly NavTab[] = hasSupport
    ? baseTabs
    : baseTabs.flatMap((tab) =>
        tab.to === "/settings"
          ? [supportTab, { ...tab, matchPrefix: tab.matchPrefix.filter((p) => p !== "/support") }]
          : [tab],
      );

  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-64 shrink-0 flex-col gap-2 border-r border-white/6 bg-zinc-950/40 px-3 py-5 backdrop-blur-xl"
    >
      {/* Brand header */}
      <div className="flex items-center gap-2.5 px-3 pb-4">
        {branding.logoUrl ? (
          <img
            src={branding.logoUrl}
            alt={branding.brandName}
            className="h-8 w-8 shrink-0 rounded-lg object-contain"
          />
        ) : (
          <ReiwaLogo className="h-8 w-8 shrink-0 text-(--brand-primary)" title={branding.brandName} />
        )}
        <span className="truncate text-base font-semibold text-white">{branding.brandName}</span>
      </div>

      {/* Primary destinations */}
      <ul className="flex flex-col gap-1">
        {(() => {
          const activeTo = resolveActiveTabTo(tabs, location.pathname);
          return tabs.map((tab) => {
          const isActive = tab.to === activeTo;
          const Icon = tab.icon;
          return (
            <li key={tab.to} className="relative">
              <NavLink
                to={tab.to}
                data-testid={`side-${tab.testId}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative z-10 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-200 select-none",
                  isActive
                    ? "text-(--brand-primary-fg)"
                    : "text-zinc-400 hover:bg-white/5 hover:text-white",
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="side-nav-active-pill"
                    className="absolute inset-0 -z-10 rounded-xl"
                    style={{ backgroundColor: "var(--brand-primary)" }}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
                <Icon className="h-5 w-5 shrink-0" strokeWidth={isActive ? 2.25 : 1.75} />
                <span className="truncate">{tab.label}</span>
                {(tab.badge ?? 0) > 0 && (
                  <span className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">
                    {(tab.badge ?? 0) > 99 ? "99+" : tab.badge}
                  </span>
                )}
              </NavLink>
            </li>
          );
          });
        })()}
      </ul>
    </nav>
  );
}
