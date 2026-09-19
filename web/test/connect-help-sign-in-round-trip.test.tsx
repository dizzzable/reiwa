// @vitest-environment jsdom

/**
 * The connect-help deep link, opened by somebody who is not signed in, comes
 * back after signing in — asked of the real `App.tsx`, its real route table,
 * the real protected shell, the real `/bootstrap` hop, the real Telegram
 * sign-in page and the real home page.
 *
 * `/dashboard?connect=help&subscriptionId=…` is where the bot's «📲 Подключить»
 * opens the cabinet. The shell used to build no `next` for `/dashboard`, so the
 * link died at the door: a Mini App opened without the cabinet's cookie signed
 * in through Telegram and landed on a plain dashboard, the card the help was
 * about unnamed and the connect door never opened.
 *
 * Only the network and the leaves are stubbed: the session and sign-in calls,
 * the pages the flow ends on (each a probe that names itself), and the shell's
 * visual chrome.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { BrowserRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  botSignin: vi.fn(),
  bootstrapTelegram: vi.fn(),
  getLanding: vi.fn(),
  getPlatformPolicy: vi.fn(),
  reportSurface: vi.fn(),
  getChannelGate: vi.fn(),
  checkChannelGate: vi.fn(),
}));
/** What the launch-detection hop answers: the Mini App's payload, or none. */
const launch = vi.hoisted(() => ({ initData: null as string | null }));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  ...api,
}));

vi.mock("@/hooks/use-telegram-webapp", () => ({ useTelegramWebApp: () => ({ telegram: null }) }));
vi.mock("@/hooks/use-ad-attribution", () => ({ useAdAttribution: () => undefined }));
vi.mock("@/hooks/use-device-signals", () => ({ useDeviceSignals: () => undefined }));
// Decided at once, either way. How long a real launch waits for the SDK is
// `telegram-launch-slow-sdk.test.tsx`'s subject, not this file's.
vi.mock("@/features/auth/telegram-launch", () => ({ detectTelegramInitData: async () => launch.initData }));

vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-app-badge", () => ({ useAppBadge: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/use-install-prompt", () => ({ isStandalonePwa: () => false }));
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn(async () => false) }));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ branding: {} }) }));
vi.mock("@/features/hints/hint-controller", () => ({ HintController: () => null }));
vi.mock("@/components/layout/bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("@/components/layout/side-nav", () => ({ SideNav: () => null }));
vi.mock("@/components/layout/app-background", () => ({ AppBackground: () => null }));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/components/ui/entry-brand-tile", () => ({ EntryBrandTile: () => null }));
vi.mock("@/components/layout/page-transition", () => ({
  PageTransition: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/layout/route-content-boundary", () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));

/** A lazy page that says which one it is. */
function page(name: string) {
  return { default: () => <p data-probe="page">{name}</p> };
}
vi.mock("@/features/landing/landing-page", () => ({ ...page("landing"), LANDING_QUERY_KEY: ["landing"] }));
vi.mock("@/features/dashboard/dashboard-page", () => page("dashboard"));
vi.mock("@/features/auth/sign-in-page", () => page("sign-in"));

import App from "@/App";
import { useSession } from "@/hooks/use-session";
import { ru } from "@/i18n/ru";
import {
  __resetTelegramLaunchCaptureForTests,
  resolveTelegramLaunchParams,
} from "@/lib/telegram-launch-params";
import type { ReiwaSession } from "@/types/api";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "ru",
  fallbackLng: "ru",
  resources: { ru: { translation: ru } },
  interpolation: { escapeValue: false },
});

const LINK = "/dashboard?connect=help&subscriptionId=cmsub0001abcdefghijklmno";
const LINK_AS_NEXT = "next=%2Fdashboard%3Fconnect%3Dhelp%26subscriptionId%3Dcmsub0001abcdefghijklmno";

/** A live launch: `auth_date` is now, or the cabinet would rightly drop it as spent. */
const INIT_DATA = `user=%7B%22id%22%3A777000111%7D&auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`;

const SESSION: ReiwaSession = {
  id: "cmfa1b2c3d0000reiwa0subscriber",
  telegramId: "777000111",
  username: "subscriber",
  name: "Subscriber",
  role: "USER",
  webAccount: null,
  onboardingCompleted: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
/** Every address the router wrote, in order. */
let visited: string[] = [];

function renderedPage(): string | null {
  return container?.querySelector('[data-probe="page"]')?.textContent ?? null;
}

function address(): string {
  return `${window.location.pathname}${window.location.search}`;
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 40; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** What `useAdAttribution` does at the app root: ask for the session and keep the answer. */
function SessionAskedAtRoot() {
  useSession();
  return null;
}

/**
 * Opens the cabinet at `url` — with Telegram's launch fragment when `miniApp`,
 * captured the way `main.tsx` captures it at module scope, before any route.
 */
async function open(url: string, miniApp: boolean): Promise<void> {
  window.history.replaceState(
    null,
    "",
    miniApp ? `${url}#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.6&tgWebAppPlatform=ios` : url,
  );
  launch.initData = miniApp ? INIT_DATA : null;
  resolveTelegramLaunchParams();
  visited = [];
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    vi.spyOn(window.history, method).mockImplementation((state, unused, next) => {
      if (typeof next === "string") visited.push(next);
      else if (next instanceof URL) visited.push(`${next.pathname}${next.search}`);
      original(state, unused, next);
    });
  }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <I18nextProvider i18n={i18n}>
          <BrowserRouter>
            <SessionAskedAtRoot />
            <App />
          </BrowserRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** No cabinet cookie until the Telegram sign-in sets one. */
function cookielessUntilTelegramSignsIn(): void {
  api.getSession.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
  api.bootstrapTelegram.mockImplementation(async () => {
    api.getSession.mockResolvedValue(SESSION);
    return { success: true, redirectUrl: "/dashboard" };
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  api.getLanding.mockRejectedValue(new Error("no landing"));
  api.getPlatformPolicy.mockResolvedValue({ requireTelegramWebCredentials: false });
  api.reportSurface.mockResolvedValue({ ok: true });
  api.getChannelGate.mockResolvedValue({ status: "off", joinUrl: null });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queryClient?.clear();
  queryClient = null;
  launch.initData = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const fn of Object.values(api)) fn.mockReset();
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState(null, "", "/");
});

describe("a Mini App opened on the deep link without the cabinet's cookie", () => {
  it("signs in through Telegram and comes back to the link, subscription and all", async () => {
    cookielessUntilTelegramSignsIn();

    await open(LINK, true);

    // The way in: the shell's redirect carried the link, `/bootstrap` handed it
    // to the Telegram sign-in, which spent it.
    expect(visited, "the shell's redirect dropped the link").toContain(`/bootstrap?${LINK_AS_NEXT}`);
    expect(visited.some((entry) => entry.startsWith("/tma?") && entry.includes(LINK_AS_NEXT))).toBe(true);
    expect(api.bootstrapTelegram).toHaveBeenCalledTimes(1);
    // The way out.
    expect(address(), "after signing in the customer met a plain dashboard").toBe(LINK);
    expect(renderedPage()).toBe("dashboard");
  });
});

describe("a browser opened on the deep link without the cabinet's cookie", () => {
  it("carries the link all the way to the sign-in form", async () => {
    api.getSession.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));

    await open(LINK, false);

    expect(renderedPage()).toBe("sign-in");
    expect(address(), "the link was lost on the way to the sign-in form").toBe(`/sign-in?${LINK_AS_NEXT}`);
  });
});

describe("somebody already signed in", () => {
  it("is not sent anywhere: the link reaches the dashboard untouched", async () => {
    api.getSession.mockResolvedValue(SESSION);

    await open(LINK, false);

    expect(renderedPage()).toBe("dashboard");
    expect(address()).toBe(LINK);
    expect(visited.filter((entry) => entry.startsWith("/bootstrap"))).toEqual([]);
  });
});
