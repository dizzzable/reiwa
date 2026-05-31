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
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShoppingCart, TicketPercent } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding-provider";
import { ReiwaLogo } from "@/components/ui/reiwa-logo";
import { isTabActive, useNavTabs } from "@/components/layout/use-nav-tabs";

export function SideNav() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { branding } = useBranding();
  const tabs = useNavTabs();

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
        {tabs.map((tab) => {
          const isActive = isTabActive(tab, location.pathname);
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
              </NavLink>
            </li>
          );
        })}
      </ul>

      {/* Quick actions */}
      <div className="mt-auto flex flex-col gap-1 border-t border-white/6 pt-3">
        <button
          onClick={() => navigate("/plans")}
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <ShoppingCart className="h-5 w-5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{t("card.actions.buy")}</span>
        </button>
        <button
          onClick={() => navigate("/promo")}
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <TicketPercent className="h-5 w-5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{t("card.actions.promo")}</span>
        </button>
      </div>
    </nav>
  );
}
