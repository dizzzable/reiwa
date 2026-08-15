/**
 * StealthLayout
 * ─────────────
 * Authenticated shell rendered behind every protected route. Composes:
 *   1. a branded background (`<NetworkBg>`),
 *   2. a scrollable main region containing the route's element wrapped in a
 *      synchronous `<PageTransition>` shell,
 *   3. the bottom navigation pill anchored above the safe-area inset.
 *
 * Session gate: we redirect to `/bootstrap` when no session is found, which
 * keeps the protected routes behind a single guard instead of every page
 * checking on its own.
 */

import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { BottomNav } from "@/components/layout/bottom-nav";
import { SideNav } from "@/components/layout/side-nav";
import { PageTransition } from "@/components/layout/page-transition";
import { RouteContentBoundary } from "@/components/layout/route-content-boundary";
import { AppBackground } from "@/components/layout/app-background";
import { NetworkBg } from "@/components/ui/network-bg";
import { OnboardingTourProvider } from "@/features/onboarding/onboarding-tour-controller";
import { useBranding } from "@/lib/branding-provider";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { isStandalonePwa } from "@/hooks/use-install-prompt";
import { useSession } from "@/hooks/use-session";
import { useUserRealtime } from "@/hooks/use-user-realtime";
import { reportSurface } from "@/lib/api-client";
import { getPlatformPolicy } from "@/lib/api-client";
import { ensurePushSubscription } from "@/lib/push";
import { nextDestinationQuery } from "@/lib/next-destination";
import { readTelegramLaunchInitData } from "@/lib/telegram-launch-params";
import { resolveAppBackgroundKind } from "@/types/branding";

type Surface = "tma" | "pwa" | "browser";
type FormFactor = "mobile" | "tablet" | "desktop";
type Os = "ios" | "android" | "windows" | "macos" | "linux" | "other";

/**
 * True when running inside a Telegram Mini App (launch `initData` present).
 *
 * Read off the launch parameters, NOT out of the bridge. `initData` IS
 * `tgWebAppData`: Telegram writes it into the launch document's URL from the
 * first byte, and `readTelegramLaunchInitData()` also restores it from the
 * in-memory capture and the SDK's session mirror — which this call NEEDS,
 * because every cabinet route is reached by a react-router navigation and that
 * drops the fragment.
 *
 * The bridge cannot be the source here. `window.Telegram` exists only after
 * ~100 KB has been fetched from `telegram.org/js/telegram-web-app.js`, and this
 * product sells VPN: the customer who taps the bot's button has no VPN yet, so
 * telegram.org is precisely the host their network blocks. Asking the bridge
 * recorded every one of those genuine Mini App launches as `browser` (or
 * `pwa`) — the usage analytics labelled the exact population hurt by the launch
 * defects as web visitors, which is a large part of why nobody spotted them.
 * A detector that is wrong only on the broken networks reports the product as
 * healthy precisely when it is not.
 *
 * `c087865` removed this pattern from the entry routes and `claim-page.tsx`
 * followed; this file was missed both times. It is the same rule as
 * `telegram-launch.ts`: URL and mirror first, bridge only as the fallback for
 * a launch shape the URL never carried (an embedder that hands the payload
 * straight to the bridge).
 */
function detectTma(): boolean {
  if (typeof window === "undefined") return false;
  if (readTelegramLaunchInitData() !== null) return true;
  const initData = window.Telegram?.WebApp?.initData;
  return typeof initData === "string" && initData.length > 0;
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
const PUSH_RESYNC_KEY = "reiwa_push_resynced";

export default function StealthLayout() {
  const { session, isLoading } = useSession();
  const { branding } = useBranding();
  const isDesktop = useIsDesktop();
  const location = useLocation();
  // Telemetry only needs the display mode, so read it directly rather than
  // calling `useInstallPrompt()` for one field of four.
  //
  // This used to say "do not mount the install-prompt listener here, Chromium
  // warns about a deferred `beforeinstallprompt` with no install CTA on screen".
  // That trade is no longer this component's to make: the listener now lives at
  // module scope in `main.tsx` and runs on every load anyway, because the event
  // fires once and never waits for a route change (see
  // `lib/install-prompt-capture.ts`). `isStandalonePwa()` is still the right
  // call here — it reads the display mode and captures nothing.
  const isStandalone = isStandalonePwa();

  // Whether the operator requires Telegram users to set a web login/password
  // before entering the cabinet.
  //
  // While this query is loading or unavailable the flag reads as FALSE — see
  // `?? false` below — so a Telegram-authenticated user is let straight into
  // the cabinet rather than held at the claim screen. That is deliberate
  // (`c1072d2` flipped it from `?? true`): a signed Mini App launch already is
  // a credential, and the failure it avoids is stranding a Telegram-first user
  // on a form they cannot complete. Note the consequence, which is the reason
  // this comment is explicit: `/platform-policy` answers `{}` on any upstream
  // error (`src/api/routes/profile.ts`), and `{}` is indistinguishable here
  // from an operator who deliberately turned the gate off.
  const { data: platformPolicy } = useQuery({
    queryKey: ["platform-policy"],
    queryFn: getPlatformPolicy,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });

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

  // Heal a rotated / pruned web-push subscription once per session (no prompt;
  // only when permission is already granted). Repairs the "push silently stops
  // arriving" drift after VAPID rotation or a server-side 410 cleanup.
  useEffect(() => {
    if (!session) return;
    try {
      if (sessionStorage.getItem(PUSH_RESYNC_KEY) === "1") return;
      sessionStorage.setItem(PUSH_RESYNC_KEY, "1");
    } catch {
      // sessionStorage unavailable — fall through; healing is idempotent.
    }
    void ensurePushSubscription();
  }, [session]);

  // Which of the two background renderers this shell mounts.
  //
  // `none` is the BUILT-IN background — `<NetworkBg>` — and it is the default.
  // It is not "no background": the operator who picks it gets the brand-tinted
  // glows, dot grid and diagonals this cabinet has always drawn. The mode that
  // really means "just the flat colour" is `plain`, which `<AppBackground>`
  // renders by drawing nothing over `--brand-bg-primary`.
  //
  // Anything this build does not recognise resolves to `none` as well
  // (`resolveAppBackgroundKind`), so a panel released ahead of this cabinet
  // degrades to the familiar default instead of a blank shell.
  const appBackgroundKind = resolveAppBackgroundKind(branding.appBackground?.kind);
  const hasAppBackground =
    branding.appBackground !== undefined && appBackgroundKind !== "none";

  // Subscribe to per-user realtime events while the session is open.
  // The hook is a no-op until `isAuthenticated` becomes true, and tears
  // down its EventSource on unmount.
  useUserRealtime();

  if (isLoading) {
    return (
      <div
        className="relative flex h-dvh items-center justify-center overflow-hidden"
        style={{
          backgroundColor:
            "var(--bootstrap-app-background-color, var(--brand-bg-primary))",
          backgroundImage: "var(--bootstrap-app-background-image, none)",
          backgroundSize: "var(--bootstrap-app-background-size, auto)",
          backgroundBlendMode:
            "var(--bootstrap-app-background-blend, normal)",
          backgroundPosition: "center",
          backgroundRepeat: "repeat",
        }}
      >
        <div
          className="relative z-10 size-8 animate-spin rounded-full border-2 border-t-transparent"
          style={{ borderColor: "var(--brand-primary)", borderTopColor: "transparent" }}
        />
      </div>
    );
  }

  // Preserve the intended destination across the bootstrap/auth handshake AND
  // across the credential gates below, so a Mini App deep-link (e.g. the expiry
  // notification's "Продлить" button → `${miniAppUrl}/renew`) lands the user on
  // the right page instead of dumping them on /dashboard.
  //
  // The gates are the half this used to miss. A first-time Telegram user taps
  // «Продлить», authenticates, is sent to /claim to pick a login — and /claim
  // finished on /dashboard, because the `next` built here was handed to
  // /bootstrap and to nothing else. `/renew` was reachable only if they went
  // looking for it.
  const intended = `${location.pathname}${location.search}`;
  const next =
    location.pathname !== "/" && location.pathname !== "/dashboard"
      ? nextDestinationQuery(intended)
      : "";

  if (!session) {
    return <Navigate to={`/bootstrap${next}`} replace />;
  }

  // A signed Telegram Mini App launch already is an authentication credential.
  // Auto-login is the default; an operator may explicitly enable the extra
  // web-login/password setup gate in Rezeis if their policy requires it.
  // Web-first accounts keep the normal credential flow.
  const requireTelegramWebCredentials = platformPolicy?.requireTelegramWebCredentials ?? false;
  const hasTelegramCredential =
    session.telegramId != null && String(session.telegramId).trim().length > 0;
  const skipCredentialSetup = hasTelegramCredential && !requireTelegramWebCredentials;

  // Mandatory claim gate (Property 1): a Telegram-first user authenticated into
  // a WebSession but with no `WebAccount` (explicit `null` from the session
  // probe) must set login + password before reaching any cabinet page. We only
  // gate on an explicit `null` — an absent/`undefined` field means the probe
  // degraded and we must not lock out an already-claimed user.
  if (session.webAccount === null && !skipCredentialSetup) {
    return <Navigate to={`/claim${next}`} replace />;
  }

  // External-auth registration gate: a user who signed up via a social provider
  // has a shell `WebAccount` (email attached) but no `login` yet. Login +
  // password stay mandatory, so force finish-setup before any cabinet route.
  if (session.webAccount && !session.webAccount.login && !skipCredentialSetup) {
    return <Navigate to={`/finish-setup${next}`} replace />;
  }

  // Temp-password users (admin-issued reset) must set a new password before
  // they can use anything. The session carries the flag from the WebAccount;
  // block every protected route until it's cleared.
  if (session.webAccount?.requiresPasswordChange) {
    return <Navigate to={`/change-password${next}`} replace />;
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
          <main className="scroll-area relative z-10 flex-1 overflow-x-hidden overflow-y-auto">
            <div className="mx-auto w-full max-w-[46rem] px-2">
              <PageTransition>
                <RouteContentBoundary>
                  <Outlet />
                </RouteContentBoundary>
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
          {/* Scrollable main content; route changes render synchronously. */}
          <main className="scroll-area relative z-10 flex-1 overflow-x-hidden overflow-y-auto">
            <PageTransition>
              <RouteContentBoundary>
                <Outlet />
              </RouteContentBoundary>
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
