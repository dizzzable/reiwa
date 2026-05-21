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
import { PageTransition } from "@/components/layout/page-transition";
import { NetworkBg } from "@/components/ui/network-bg";
import { OnboardingTourProvider } from "@/features/onboarding/onboarding-tour-controller";
import { useSession } from "@/hooks/use-session";
import { useUserRealtime } from "@/hooks/use-user-realtime";

export default function StealthLayout() {
  const { session, isLoading } = useSession();

  // Subscribe to per-user realtime events while the session is open.
  // The hook is a no-op until `isAuthenticated` becomes true, and tears
  // down its EventSource on unmount.
  useUserRealtime();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-(--brand-bg-primary)">
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

  return (
    <OnboardingTourProvider>
      <div className="relative flex h-full flex-col overflow-hidden bg-(--brand-bg-primary) text-foreground">
        <NetworkBg />

        {/* Scrollable main content with page-transition wrapper */}
        <main className="relative z-10 flex-1 overflow-y-auto scroll-area">
          <PageTransition>
            <Outlet />
          </PageTransition>
        </main>

        {/* Bottom navigation (floating pill) */}
        <div className="relative z-20 shrink-0" data-tour="bottom-nav">
          <BottomNav />
        </div>
      </div>
    </OnboardingTourProvider>
  );
}
