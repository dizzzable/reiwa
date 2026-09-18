// @vitest-environment jsdom

/**
 * A bot sign-in link signs the customer in on EVERY cabinet path — asked of the
 * real `App.tsx`, its real route table, the real protected shell, the real
 * `/bootstrap` hop and the real home page.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The bot stamps `?signin=<token>` onto whatever cabinet address a button
 * opens: `/` for «Кабинет», `/dashboard` for the trial button when no Mini App
 * is configured, `/plans` or `/renew` for an operator's own button. Only the
 * home page ever read it. On any other path the shell found no session and
 * redirected to `/bootstrap` — bare for `/dashboard`, and with the token buried
 * inside `next` for the rest — `/bootstrap` forwarded to `/`, and the home page
 * found no `signin` at all. The customer who pressed «Попробовать бесплатно» in
 * the bot met a sign-in form for an account with no password; the token was
 * never spent.
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
  getLanding: vi.fn(),
  getPlatformPolicy: vi.fn(),
  reportSurface: vi.fn(),
  getChannelGate: vi.fn(),
  checkChannelGate: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  ...api,
}));

// App-level hooks with nothing to say about sign-in.
vi.mock("@/hooks/use-telegram-webapp", () => ({ useTelegramWebApp: () => ({ telegram: null }) }));
vi.mock("@/hooks/use-ad-attribution", () => ({ useAdAttribution: () => undefined }));
vi.mock("@/hooks/use-device-signals", () => ({ useDeviceSignals: () => undefined }));
// A plain browser, decided at once. How long a real launch waits for the SDK is
// `telegram-launch-slow-sdk.test.tsx`'s subject, not this file's.
vi.mock("@/features/auth/telegram-launch", () => ({ detectTelegramInitData: async () => null }));

// The real shell's chrome and side effects.
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
vi.mock("@/features/plans/plans-page", () => page("plans"));
vi.mock("@/features/renewal/renewal-page", () => page("renew"));
vi.mock("@/features/auth/sign-in-page", () => page("sign-in"));
vi.mock("@/features/auth/tma-bootstrap-page", () => page("tma"));

import App from "@/App";
import { useSession } from "@/hooks/use-session";
import { ru } from "@/i18n/ru";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";
import type { ReiwaSession } from "@/types/api";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "ru",
  fallbackLng: "ru",
  resources: { ru: { translation: ru } },
  interpolation: { escapeValue: false },
});

const TOKEN = "5f".repeat(32);

/**
 * A Telegram-first subscriber the shell lets straight through, as `/session`
 * passes it on — the wire carries fields the client type does not name, which
 * is why it is built apart and then assigned.
 */
const SESSION_WIRE = {
  id: "cmfa1b2c3d0000reiwa0subscriber",
  telegramId: "777000111",
  username: "subscriber",
  name: "Subscriber",
  email: null,
  role: "USER",
  language: "RU",
  personalDiscount: 0,
  purchaseDiscount: 0,
  points: 0,
  maxSubscriptions: 3,
  isBlocked: false,
  isBotBlocked: false,
  isRulesAccepted: true,
  onboardingCompleted: true,
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-09-14T18:00:00.000Z",
  lastSeenAt: null,
  webAccount: null,
};
const SESSION: ReiwaSession = SESSION_WIRE;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function renderedPage(): string | null {
  return container?.querySelector('[data-probe="page"]')?.textContent ?? null;
}

/** Lets the redirects, lazy pages and requests of the flow run to their end. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 40; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * What `useAdAttribution` does at the app root in production: ask for the
 * session on mount and keep the answer cached. It is stubbed out above, and
 * without this stand-in the flow never meets the cached "no session" a real
 * visit meets right after signing in.
 */
function SessionAskedAtRoot() {
  useSession();
  return null;
}

/** Every address the router wrote, in order. */
let visited: string[] = [];

/** Opens the cabinet at `url`, as the in-app browser does when a bot button is pressed. */
async function openFromBot(url: string): Promise<void> {
  window.history.replaceState(null, "", url);
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

/** A browser with no cabinet cookie, whose token is good: the sign-in sets one. */
function cookielessWithAGoodToken(): void {
  api.getSession.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
  api.botSignin.mockImplementation(async () => {
    api.getSession.mockResolvedValue(SESSION);
    return { success: true, redirectUrl: "/dashboard" };
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  api.getLanding.mockRejectedValue(new Error("no landing"));
  api.getPlatformPolicy.mockResolvedValue({ requireTelegramWebCredentials: false });
  api.reportSurface.mockResolvedValue({ ok: true });
  api.getChannelGate.mockResolvedValue({ status: "not-required" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queryClient?.clear();
  queryClient = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const fn of Object.values(api)) fn.mockReset();
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState(null, "", "/");
});

describe("a bot sign-in link on a cabinet page other than the root", () => {
  it("signs in the trial button's /dashboard link and lands on the dashboard", async () => {
    cookielessWithAGoodToken();

    await openFromBot(`/dashboard?signin=${TOKEN}`);

    expect(
      api.botSignin,
      "the token was never spent — the customer is on the sign-in form of an account that has no password",
    ).toHaveBeenCalledWith(TOKEN);
    expect(window.location.pathname).toBe("/dashboard");
    expect(window.location.search).toBe("");
    expect(renderedPage()).toBe("dashboard");
  });

  it("signs in an operator's /plans link and lands on /plans, with its own query kept", async () => {
    cookielessWithAGoodToken();

    await openFromBot(`/plans?utm_source=tg&signin=${TOKEN}`);

    expect(api.botSignin).toHaveBeenCalledWith(TOKEN);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/plans?utm_source=tg");
    expect(renderedPage()).toBe("plans");
  });

  it("spends the token even when a session already exists, and still lands where the link went", async () => {
    // Same as the root link has always done: the token names the Telegram user
    // who pressed the button. Here it has expired; the page is still /renew and
    // the dead token is gone from the address bar.
    api.getSession.mockResolvedValue(SESSION);
    api.botSignin.mockRejectedValue(Object.assign(new Error("Invalid or expired link"), { status: 401 }));

    await openFromBot(`/renew?signin=${TOKEN}`);

    expect(api.botSignin).toHaveBeenCalledTimes(1);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/renew");
    expect(renderedPage()).toBe("renew");
  });
});

describe("what did not change", () => {
  it("signs in the root link and lands on the dashboard, as before", async () => {
    cookielessWithAGoodToken();

    await openFromBot(`/?signin=${TOKEN}`);

    expect(api.botSignin).toHaveBeenCalledWith(TOKEN);
    expect(window.location.pathname).toBe("/dashboard");
    expect(renderedPage()).toBe("dashboard");
  });

  it("does not try a value no sign-in could accept", async () => {
    api.getSession.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));

    await openFromBot("/plans?signin=not-a-token");

    expect(api.botSignin).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/sign-in");
    expect(renderedPage()).toBe("sign-in");
  });
});

describe("the ways the first version of this went wrong", () => {
  it("does not freeze on the splash for a link to a path with no route", async () => {
    // The home page decides once per mount. `/` → sign-in → `/no-such-page`
    // matched the catch-all, which renders the same page component in the same
    // place, and React kept the instance that had already decided.
    cookielessWithAGoodToken();

    await openFromBot(`/no-such-page?signin=${TOKEN}`);

    expect(api.botSignin).toHaveBeenCalledWith(TOKEN);
    expect(window.location.pathname).toBe("/dashboard");
    expect(renderedPage()).toBe("dashboard");
  });

  it("does not freeze on the splash for a next that leads back to the root", async () => {
    cookielessWithAGoodToken();

    await openFromBot(`/?signin=${TOKEN}&next=%2F`);

    expect(window.location.pathname).toBe("/dashboard");
    expect(renderedPage()).toBe("dashboard");
  });

  it("goes straight to the page after signing in, not round through /bootstrap", async () => {
    // The root asks for the session on mount, before the cookie exists, and on
    // a slow network that ask is still out when the sign-in lands. A navigation
    // that only invalidated the cache reached the shell while "no session"
    // stood; a fetch that joined the root's ask was handed its "no session".
    // Either way the shell sent the customer who had just signed in round
    // through `/bootstrap`.
    const unauthorized = () => Object.assign(new Error("Unauthorized"), { status: 401 });
    let rootAskOut = false;
    let rootAskOutAtSignIn = false;
    let answerRootAsk: () => void = () => undefined;
    api.getSession.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rootAskOut = true;
          answerRootAsk = () => {
            rootAskOut = false;
            reject(unauthorized());
          };
        }),
    );
    api.getSession.mockRejectedValue(unauthorized());
    api.botSignin.mockImplementation(async () => {
      rootAskOutAtSignIn = rootAskOut;
      api.getSession.mockResolvedValue(SESSION);
      // The root's ask, sent before the cookie existed, answers only now.
      setTimeout(() => answerRootAsk(), 0);
      return { success: true, redirectUrl: "/dashboard" };
    });

    await openFromBot(`/dashboard?signin=${TOKEN}`);

    expect(
      rootAskOutAtSignIn,
      "the root's session ask had already answered, so there was nothing in flight to join",
    ).toBe(true);
    const signedInAt = visited.findIndex((url) => url.startsWith("/?signin="));
    expect(signedInAt, visited.join(" → ")).toBeGreaterThanOrEqual(0);
    const afterSignIn = visited.slice(signedInAt);
    expect(afterSignIn.some((url) => url.startsWith("/bootstrap")), afterSignIn.join(" → ")).toBe(false);
    expect(renderedPage()).toBe("dashboard");
  });

  it("keeps the router's history index, so back arrows still go back", async () => {
    cookielessWithAGoodToken();

    await openFromBot(`/plans?signin=${TOKEN}`);

    expect(renderedPage()).toBe("plans");
    expect(
      Number.isInteger((window.history.state as { idx?: unknown } | null)?.idx),
      `history state lost the router's index: ${JSON.stringify(window.history.state)}`,
    ).toBe(true);
  });

  it("does not freeze on a next that a URL parser would read as another origin", async () => {
    // `/<TAB>/evil.example/renew` starts with one slash, and its path as a URL
    // parser reads it is `/renew`, not the root — so the character check is
    // the only thing that stops it. `history.replaceState` reads it as
    // `//evil.example/renew` and throws.
    api.getSession.mockResolvedValue(SESSION);

    await openFromBot("/?next=%2F%09%2Fevil.example%2Frenew");

    expect(window.location.origin).toBe("http://localhost:3000");
    expect(window.location.pathname).toBe("/dashboard");
    expect(renderedPage()).toBe("dashboard");
  });
});
