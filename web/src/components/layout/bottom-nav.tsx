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
import { NavLink, useLocation } from "react-router-dom";

import { cn } from "@/lib/utils";
import { isTabActive, useNavTabs } from "@/components/layout/use-nav-tabs";

export function BottomNav() {
  const location = useLocation();
  const tabs = useNavTabs();

  return (
    <nav
      aria-label="Primary"
      className="relative shrink-0"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {/* Outer glass capsule — matches the design reference (Telegram-style). */}
      <div className="mx-3 mb-3 rounded-full border border-white/6 bg-zinc-900/85 px-1 py-1 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <ul
          className="relative grid gap-1"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
        >
          {tabs.map((tab) => {
            const isActive = isTabActive(tab, location.pathname);
            const Icon = tab.icon;
            return (
              <li key={tab.to} className="relative">
                <NavLink
                  to={tab.to}
                  data-testid={tab.testId}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative z-10 flex items-center justify-center gap-2 rounded-full px-3 py-2.5 text-sm font-medium transition-colors duration-200 select-none",
                    isActive
                      ? "text-(--brand-primary-fg)"
                      : "text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  {/* Animated active-tab pill — the layoutId trick crossfades
                      the background between tabs with a spring transition. */}
                  {isActive && (
                    <motion.span
                      layoutId="bottom-nav-active-pill"
                      className="absolute inset-0 -z-10 rounded-full"
                      style={{ backgroundColor: "var(--brand-primary)" }}
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 30,
                      }}
                    />
                  )}
                  <Icon
                    className="h-5 w-5 shrink-0"
                    strokeWidth={isActive ? 2.25 : 1.75}
                  />
                  <span
                    className={cn(
                      "truncate transition-[max-width,opacity] duration-200",
                      isActive ? "max-w-[140px] opacity-100" : "max-w-0 opacity-0",
                    )}
                  >
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
