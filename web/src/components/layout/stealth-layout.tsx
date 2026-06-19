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

import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { BottomNav } from "@/components/layout/bottom-nav";
import { SideNav } from "@/components/layout/side-nav";
import { PageTransition } from "@/components/layout/page-transition";
import { AppBackground } from "@/components/layout/app-background";
import { NetworkBg } from "@/components/ui/network-bg";
import { OnboardingTourProvider } from "@/features/onboarding/onboarding-tour-controller";
import { useBranding } from "@/lib/branding-provider";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { useSession } from "@/hooks/use-session";
import { useUserRealtime } from "@/hooks/use-user-realtime";
import { reportSurface } from "@/lib/api-client";

type Surface = "tma" | "pwa" | "browser";
type FormFactor = "mobile" | "tablet" | "desktop";
type Os = "ios" | "android" | "windows" | "macos" | "linux" | "other";

/** True when running inside a Telegram Mini App (validated initData present). */
function detectTma(): boolean {
  if (typeof window === "undefined") return false;
  const tg = (window as { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return typeof tg?.WebApp?.initData === "string" && tg.WebApp.initData.length > 0;
}

/** Detect the host OS from the UA for usage analytics. */
function detectOs(): Os {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  if (
    /iphone|ipad|ipod/i.test(ua) ||
    (/macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)
  ) {
    return "ios";
  }
  if (/windows/i.test(ua)) return "windows";
  if (/macintosh|mac os x/i.test(ua)) return "macos";
  if (/linux/i.test(ua)) return "linux";
  return "other";
}

/** Detect the device form factor from the UA. */
function detectFormFactor(): FormFactor {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  const isTablet =
    /ipad/i.test(ua) ||
    (/macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) ||
    (/android/i.test(ua) && !/mobile/i.test(ua));
  if (isTablet) return "tablet";
  if (/mobile|iphone|ipod|android.+mobile/i.test(ua)) return "mobile";
  return "desktop";
}

const SURFACE_REPORTED_KEY = "reiwa_surface_reported";

export default function StealthLayout() {
  const { session, isLoading } = useSession();
  const { branding } = useBranding();
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const { isStandalone } = useInstallPrompt();

  // Report the usage surface (tma/pwa/browser) + form factor + os once per
  // browser session. Installed-PWA sessions get upgraded to the 30-day window
  // server-side; everything feeds the admin usage analytics. Guarded by
  // sessionStorage so we report at most once per tab session.
  useEffect(() => {
    if (!session) return;
    try {
      if (sessionStorage.getItem(SURFACE_REPORTED_KEY) === "1") return;
      sessionStorage.setItem(SURFACE_REPORTED_KEY, "1");
    } catch {
      // sessionStorage unavailable (private mode) — fall through and report;
      // worst case it's one extra request, never a crash.
    }
    const surface: Surface = detectTma() ? "tma" : isStandalone ? "pwa" : "browser";
    void reportSurface({ surface, formFactor: detectFormFactor(), os: detectOs() });
  }, [session, isStandalone]);

  // When the operator configured a custom app background it takes precedence
  // over the default ambient `NetworkBg` (single WebGL context, no double FX).
  const hasAppBackground =
    branding.appBackground !== undefined && branding.appBackground.kind !== "none";

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
    // Preserve the intended destination across the bootstrap/auth handshake so
    // a Mini App deep-link (e.g. the expiry notification's "Продлить" button →
    // `${miniAppUrl}/renew`) lands the user on the right page after auth instead
    // of dumping them on /dashboard.
    const intended = `${location.pathname}${location.search}`;
    const next =
      location.pathname !== "/" && location.pathname !== "/dashboard"
        ? `?next=${encodeURIComponent(intended)}`
        : "";
    return <Navigate to={`/bootstrap${next}`} replace />;
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
          {hasAppBackground ? <AppBackground /> : <NetworkBg />}
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
        {hasAppBackground ? <AppBackground /> : <NetworkBg />}

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
