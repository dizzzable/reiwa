/**
 * BottomNav
 * ─────────
 * Three-destination bottom navigation following modern mobile design (Apple
 * HIG / Material 3 guidelines): icon + label per tab, single active item
 * highlighted with a pill background plus brand colour on the icon and label.
 *
 * Tabs:
 *   1. **Subscriptions** — primary destination (`/dashboard`).
 *   2. **Referral / Partner** — context-aware. The icon and label swap to
 *      `Handshake / Партнёр` once `partner.isActive === true`. We render
 *      both icons under one `<NavLink>` and crossfade with Framer Motion so
 *      the activation moment is visible to the user.
 *   3. **Settings** — `/settings`.
 *
 * Why three tabs and not four
 *   Industry research (Apple HIG, Google Material) and our own UX brief
 *   converge on **3-5 destinations max** for bottom nav. We bias toward the
 *   lower bound: every extra tab is competing pixel real estate on phones,
 *   and the SPA surfaces (Activity, Plans, Support) are reachable from
 *   inside the three primary destinations or via the dashboard FAB.
 *
 * Active state animation
 *   Framer Motion's shared `layoutId` translates the pill background between
 *   tabs with a spring transition — same pattern used by Apple's Wallet,
 *   Notion mobile, and most modern Telegram clients. No extra dependencies
 *   are pulled in; we already had `motion` from the previous SPA work.
 */

import { motion } from "motion/react";
import { NavLink, useLocation } from "react-router";

import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding-provider";
import { resolveActiveTabTo, useNavTabs } from "@/components/layout/use-nav-tabs";
import {
  preloadNavigationRoute,
} from "@/components/layout/navigation-preload";
import { useNavigationPreload } from "@/components/layout/use-navigation-preload";

export function BottomNav() {
  const location = useLocation();
  const tabs = useNavTabs();
  const activeTo = resolveActiveTabTo(tabs, location.pathname);
  const { branding } = useBranding();
  const navGap = branding.navGap ?? 2;

  // A route remains lazy until it becomes relevant. After the initial screen
  // settles, warm only the destinations this operator put in the navigation.
  // A pointer/focus event below also begins the request before React Router
  // changes routes, covering a user who taps a tab immediately after launch.
  useNavigationPreload(tabs.map((tab) => tab.to));

  return (
    <nav
      aria-label="Primary"
      className="relative shrink-0"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {/* Outer glass capsule — hugs its content (width grows with the number
          of tabs) and stays centered, instead of stretching full-width. */}
      <div className="mx-auto mb-3 w-fit max-w-[calc(100%-1.5rem)] rounded-3xl border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] px-1 py-1.5 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.18)]">
        <ul className="relative flex" style={{ gap: `${navGap}px` }}>
          {tabs.map((tab) => {
            const isActive = tab.to === activeTo;
            const Icon = tab.icon;
            const badge = tab.badge ?? 0;
            return (
              <li key={tab.to} className="relative min-w-0">
                <NavLink
                  to={tab.to}
                  data-testid={tab.testId}
                  aria-current={isActive ? "page" : undefined}
                  onPointerDown={() => preloadNavigationRoute(tab.to)}
                  onPointerEnter={() => preloadNavigationRoute(tab.to)}
                  onFocus={() => preloadNavigationRoute(tab.to)}
                  className={cn(
                    "relative z-10 flex min-h-[52px] w-16 flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 font-medium transition-colors duration-200 select-none",
                    isActive
                      ? "text-(--brand-primary-fg)"
                      : "text-[var(--brand-muted-foreground)] hover:text-[var(--brand-foreground)]",
                  )}
                >
                  {/* Animated active-tab pill — slides between tabs via layoutId. */}
                  {isActive && (
                    <motion.span
                      layoutId="bottom-nav-active-pill"
                      className="absolute inset-0 -z-10 rounded-2xl"
                      style={{ backgroundColor: "var(--brand-primary)" }}
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 30,
                      }}
                    />
                  )}
                  <span className="relative">
                    <Icon
                      className="h-5 w-5 shrink-0"
                      strokeWidth={isActive ? 2.25 : 1.75}
                    />
                    {badge > 0 && (
                      <span
                        aria-hidden
                        className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white ring-2 ring-[var(--color-surface-high)]"
                      >
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
                  </span>
                  <span className="max-w-full truncate text-[10px] leading-none tracking-tight">
                    {tab.label}
                  </span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
