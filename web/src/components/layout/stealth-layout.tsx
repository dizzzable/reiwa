/**
 * StealthLayout
 * ─────────────
 * Authenticated shell rendered behind every protected route. Composes:
 *   1. a branded background (`<NetworkBg>`),
 *   2. a scrollable main region containing the route's element wrapped in a
 *      `<PageTransition>` so navigations crossfade,
 *   3. the bottom navigation pill anchored above the safe-area inset.
 *
 * Session gate: we redirect to `/bootstrap` when no session is found, which
 * keeps the protected routes behind a single guard instead of every page
 * checking on its own.
 */

import { Navigate, Outlet } from "react-router-dom";

import { BottomNav } from "@/components/layout/bottom-nav";
import { SideNav } from "@/components/layout/side-nav";
import { PageTransition } from "@/components/layout/page-transition";
import { NetworkBg } from "@/components/ui/network-bg";
import { OnboardingTourProvider } from "@/features/onboarding/onboarding-tour-controller";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useSession } from "@/hooks/use-session";
import { useUserRealtime } from "@/hooks/use-user-realtime";

export default function StealthLayout() {
  const { session, isLoading } = useSession();
  const isDesktop = useIsDesktop();

  // Subscribe to per-user realtime events while the session is open.
  // The hook is a no-op until `isAuthenticated` becomes true, and tears
  // down its EventSource on unmount.
  useUserRealtime();

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-(--brand-bg-primary)">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
          style={{ borderColor: "var(--brand-primary)", borderTopColor: "transparent" }}
        />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/bootstrap" replace />;
  }

  // Mandatory claim gate (Property 1): a Telegram-first user authenticated into
  // a WebSession but with no `WebAccount` (explicit `null` from the session
  // probe) must set login + password before reaching any cabinet page. We only
  // gate on an explicit `null` — an absent/`undefined` field means the probe
  // degraded and we must not lock out an already-claimed user.
  if (session.webAccount === null) {
    return <Navigate to="/claim" replace />;
  }

  // Temp-password users (admin-issued reset) must set a new password before
  // they can use anything. The session carries the flag from the WebAccount;
  // block every protected route until it's cleared.
  if (session.webAccount?.requiresPasswordChange) {
    return <Navigate to="/change-password" replace />;
  }

  if (isDesktop) {
    // Desktop shell: persistent left sidebar + a wider, centred content
    // column. Same routes/pages as mobile — only the chrome differs.
    return (
      <OnboardingTourProvider>
        <div className="relative flex h-dvh w-full overflow-hidden bg-(--brand-bg-primary) text-foreground">
          <NetworkBg />
          <div className="relative z-20 shrink-0" data-tour="bottom-nav">
            <SideNav />
          </div>
          <main className="scroll-area relative z-10 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[46rem] px-2">
              <PageTransition>
                <Outlet />
              </PageTransition>
            </div>
          </main>
        </div>
      </OnboardingTourProvider>
    );
  }

  return (
    <OnboardingTourProvider>
      {/* Full-viewport branded backdrop; the cabinet itself lives in a
          phone-width column centered on desktop (see .app-shell). */}
      <div className="relative flex h-dvh w-full justify-center overflow-hidden bg-(--brand-bg-primary) text-foreground">
        <NetworkBg />

        <div className="app-shell z-10 flex flex-col overflow-hidden">
          {/* Scrollable main content with page-transition wrapper */}
          <main className="scroll-area relative z-10 flex-1 overflow-y-auto">
            <PageTransition>
              <Outlet />
            </PageTransition>
          </main>

          {/* Bottom navigation (floating pill) */}
          <div className="relative z-20 shrink-0" data-tour="bottom-nav">
            <BottomNav />
          </div>
        </div>
      </div>
    </OnboardingTourProvider>
  );
}
