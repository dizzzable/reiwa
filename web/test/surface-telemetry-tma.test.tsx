// @vitest-environment jsdom

/**
 * The usage telemetry must call a Mini App launch `tma` on a network that
 * cannot reach telegram.org.
 *
 * `StealthLayout` reports `{ surface, formFactor, os }` once per browser
 * session; `surface` is the only field that answers "Mini App or web?". It used
 * to be decided by reading `window.Telegram.WebApp.initData` — the bridge,
 * which exists only after ~100 KB has been fetched from telegram.org. This
 * product sells VPN, so the customer who taps the bot's button has no VPN yet
 * and telegram.org is exactly the host their network blocks. Every genuine Mini
 * App launch on such a network was therefore recorded as `browser` (or `pwa`).
 *
 * That is not merely a wrong number. It mislabelled the exact population hurt
 * by the Mini App launch defects as web visitors, so the analytics reported the
 * Telegram surface as healthy precisely where it was broken — a large part of
 * why the defects went unnoticed. `c087865` removed this pattern from the entry
 * routes and `claim-page.tsx` followed; this file was missed both times.
 *
 * So every case below defines `window.Telegram` NOWHERE. Anything reported as
 * `tma` here had to be decided from the launch parameters alone. The last case
 * holds the other end: with no launch parameters and no bridge the surface must
 * NOT be `tma`, so the fix cannot be "label everything Telegram".
 *
 * This executes `detectTma` through the component that owns it rather than
 * reading the file's source text. Two sentinels in this subsystem have gone
 * green over text while the behaviour they named was broken — one of them by
 * reading a different file entirely.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The transport. `reportSurface` is the request this file is about. */
const api = vi.hoisted(() => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
const sessionState = vi.hoisted(() => ({
  // A claimed account, so the layout renders its shell instead of redirecting
  // to a credential gate.
  session: {
    userId: "u1",
    telegramId: "42",
    webAccount: { login: "existing-user", requiresPasswordChange: false },
  } as unknown,
  isLoading: false,
}));
/** Not an installed PWA, so the non-`tma` answer is `browser`. */
const standalone = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn() }));
vi.mock("@/hooks/use-session", () => ({ useSession: () => sessionState }));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/use-install-prompt", () => ({
  isStandalonePwa: () => standalone.value,
}));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ branding: {} }) }));
// React Query is only used for the platform-policy probe, which decides a
// credential gate, not a surface. Leave it unresolved — the layout treats that
// as "no extra gate" by design.
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("react-router", () => ({
  Navigate: () => null,
  Outlet: () => null,
  useLocation: () => ({ pathname: "/dashboard", search: "" }),
}));
vi.mock("@/components/layout/bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("@/components/layout/side-nav", () => ({ SideNav: () => null }));
vi.mock("@/components/layout/app-background", () => ({ AppBackground: () => null }));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/components/layout/page-transition", () => ({
  PageTransition: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/layout/route-content-boundary", () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));

import StealthLayout from "@/components/layout/stealth-layout";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

/**
 * A signed Telegram launch payload, i.e. a non-empty `initData`, with
 * `auth_date` stamped NOW rather than 1970.
 *
 * The cabinet refuses to replay a CARRIED payload past the server's own 24h
 * window (`telegram-launch-params.ts`, `isSpentLaunchPayload`) — the server
 * would answer it 401 and the error screen's Retry would reload into the same
 * 401 forever. A fixture stamped 1970 is exactly that dead payload, so every
 * mirror/memory case below would be asserting on a launch the product is right
 * to drop. This says what the fixture always claimed to be: a live launch.
 */
const LAUNCH_AUTH_DATE = Math.floor(Date.now() / 1000);
const INIT_DATA = `user=%7B%22id%22%3A42%7D&auth_date=${LAUNCH_AUTH_DATE}&hash=deadbeef`;
/** The SDK's own session key; the cabinet mirrors the launch into it. */
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<StealthLayout />);
  });
}

/** The `surface` field of the single report this mount produced. */
function reportedSurface(): string {
  expect(
    api.reportSurface,
    "the layout reported no surface at all — the telemetry this file is about never ran",
  ).toHaveBeenCalledTimes(1);
  return (api.reportSurface.mock.calls[0]?.[0] as { surface?: string }).surface ?? "";
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/dashboard");
  window.location.hash = "";
  window.sessionStorage.clear();
  // The module's in-memory launch capture survives client-side navigation by
  // design, and therefore leaks across spec files; clear it so each case starts
  // from a cold document.
  __resetTelegramLaunchCaptureForTests();
  // The whole point: the bridge never arrives. telegram.org is unreachable.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  standalone.value = false;
  api.reportSurface.mockResolvedValue({ ok: true });
  api.getPlatformPolicy.mockResolvedValue({});
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("usage telemetry — the surface of a Mini App launch with no Telegram SDK", () => {
  it("reports `tma` for a launch carrying tgWebAppData in the URL", () => {
    window.location.hash = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.6`;

    mount();

    expect(
      reportedSurface(),
      "a real Mini App launch was recorded as a web visitor — the analytics mislabels exactly the users whose network cannot reach telegram.org, which is the population the launch defects hurt",
    ).toBe("tma");
    expect(window.Telegram, "the bridge was defined; this case proves nothing").toBeUndefined();
  });

  it("reports `tma` from the session mirror once the hash is gone", () => {
    // The realistic shape for this layout: every cabinet route is reached by a
    // react-router navigation from `/tma` or `/bootstrap`, and that drops the
    // fragment. The mirror the launch document wrote is all that is left of the
    // payload by the time the telemetry runs — and it is enough.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppVersion: "9.6" }),
    );
    expect(window.location.hash).toBe("");

    mount();

    expect(reportedSurface()).toBe("tma");
  });

  it("does not report `tma` for a plain browser with no launch parameters", () => {
    // No fragment, no mirror, no bridge. Nothing here is a Telegram launch, and
    // a fix that answered `tma` anyway would be just as useless as the one it
    // replaced — every surface would read the same.
    mount();

    expect(
      reportedSurface(),
      "a plain browser visit was recorded as a Mini App launch — the detector now labels everything `tma` and still cannot distinguish the two surfaces",
    ).toBe("browser");
  });
});
