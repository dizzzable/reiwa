// @vitest-environment jsdom

/**
 * The cabinet's front door after the web landing (0.9.7.54) — asked of the real
 * `App.tsx`, its real route table, the real home page and the real «Документы»
 * page.
 *
 * ── What changed ────────────────────────────────────────────────────────────
 *
 * The operator could publish a web landing in the panel. `/` sent a visitor
 * without a session to it, at `/welcome`, when one was published; `/welcome`
 * drew it, and fell back to the sign-in form otherwise. The owner removed the
 * landing without a replacement, so:
 *
 *   - `/` without a session goes to the sign-in form, and asks nothing first;
 *   - `/welcome` — where ads and old links still point — is the sign-in form,
 *     with EVERY parameter of the link kept, not only the ones `keepQuery`
 *     knows: the landing's own exit kept `utm_*` and `ref` and dropped the
 *     rest, so a click id an ad network appends died there;
 *   - «Документы» with no history to go back to returns to `/`, which picks
 *     «Главная» or the sign-in form. It returned to `/welcome`, which now
 *     means the sign-in form even for a subscriber who is signed in.
 *
 * Only the network and the leaves are stubbed: the session calls, the pages the
 * flows end on (each a probe that names itself), and the shell's chrome.
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
  getPlatformPolicy: vi.fn(),
  reportSurface: vi.fn(),
  getChannelGate: vi.fn(),
  checkChannelGate: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  ...api,
}));

// App-level hooks with nothing to say about the front door.
vi.mock("@/hooks/use-telegram-webapp", () => ({ useTelegramWebApp: () => ({ telegram: null }) }));
vi.mock("@/hooks/use-ad-attribution", () => ({ useAdAttribution: () => undefined }));
vi.mock("@/hooks/use-device-signals", () => ({ useDeviceSignals: () => undefined }));
// A plain browser, decided at once.
vi.mock("@/features/auth/telegram-launch", () => ({ detectTelegramInitData: async () => null }));
// «Документы» with nothing switched on: the page draws its header and back arrow.
vi.mock("@/lib/use-legal-documents", () => ({
  useLegalDocuments: () => ({ documents: [], isLoading: false, failed: false, retry: () => undefined }),
}));

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
vi.mock("@/features/dashboard/dashboard-page", () => page("dashboard"));
vi.mock("@/features/auth/sign-in-page", () => page("sign-in"));
vi.mock("@/features/auth/register-page", () => page("register"));

import App from "@/App";
import { useSession } from "@/hooks/use-session";
import { ru } from "@/i18n/ru";
import { apiClient } from "@/lib/api-client/transport";
import { keepQuery } from "@/lib/keep-query";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";
import type { ReiwaSession } from "@/types/api";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "ru",
  fallbackLng: "ru",
  resources: { ru: { translation: ru } },
  interpolation: { escapeValue: false },
});

const SESSION: ReiwaSession = {
  id: "cmfa1b2c3d0000reiwa0subscriber",
  telegramId: "777000111",
  name: "Subscriber",
  role: "USER",
  onboardingCompleted: true,
  webAccount: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
/** Every address the router wrote, in order. */
let visited: string[] = [];
/** Every path the SPA asked the cabinet API for with a GET. */
let requested: string[] = [];

function renderedPage(): string | null {
  return container?.querySelector('[data-probe="page"]')?.textContent ?? null;
}

function address(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** Lets the redirects, lazy pages and requests of the flow run to their end. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 40; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** What `useAdAttribution` does at the app root in production: ask for the session. */
function SessionAskedAtRoot() {
  useSession();
  return null;
}

/** Opens the cabinet at `url`, as a browser does when a link is followed. */
async function open(url: string): Promise<void> {
  window.history.replaceState(null, "", url);
  visited = [];
  requested = [];
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    vi.spyOn(window.history, method).mockImplementation((state, unused, next) => {
      if (typeof next === "string") visited.push(next);
      else if (next instanceof URL) visited.push(`${next.pathname}${next.search}`);
      original(state, unused, next);
    });
  }
  // Nothing here reaches a network; every GET the pages make is written down.
  vi.spyOn(apiClient, "get").mockImplementation(async (path: string) => {
    requested.push(path);
    throw new Error(`no network in this test: GET ${path}`);
  });
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

function noSession(): void {
  api.getSession.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
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

describe("an ad or an old link to /welcome", () => {
  it("opens the sign-in form with every parameter of the link — the ad network's own ids too", async () => {
    noSession();

    await open("/welcome?utm_source=vk&utm_medium=cpc&utm_campaign=autumn&ref=friend&yclid=42&gclid=abc");

    expect(renderedPage()).toBe("sign-in");
    expect(address()).toBe("/sign-in?utm_source=vk&utm_medium=cpc&utm_campaign=autumn&ref=friend&yclid=42&gclid=abc");
    // And on to registration: the form's link carries the marks the register
    // page reads (`keepQuery`, which the sign-in page uses for that link).
    expect(keepQuery("/register")).toBe("/register?utm_source=vk&utm_medium=cpc&utm_campaign=autumn&ref=friend");
    expect(requested.filter((path) => path.includes("landing")), requested.join(", ")).toEqual([]);
  });

  it("keeps the sign-in form's own destination", async () => {
    noSession();

    await open("/welcome?next=%2Frenew&utm_source=tg");

    expect(renderedPage()).toBe("sign-in");
    expect(address()).toBe("/sign-in?next=%2Frenew&utm_source=tg");
  });

  it("with nothing after it, is the bare sign-in form", async () => {
    noSession();

    await open("/welcome");

    expect(renderedPage()).toBe("sign-in");
    expect(address()).toBe("/sign-in");
  });
});

describe("the cabinet's root without a session", () => {
  it("goes to the sign-in form with the acquisition marks, and asks nothing about a landing", async () => {
    noSession();

    await open("/?utm_source=vk&ref=friend");

    expect(renderedPage()).toBe("sign-in");
    expect(address()).toBe("/sign-in?utm_source=vk&ref=friend");
    expect(
      visited.some((url) => url.startsWith("/welcome")),
      `the root decided on the landing's address: ${visited.join(" → ")}`,
    ).toBe(false);
    expect(requested.filter((path) => path.includes("landing")), requested.join(", ")).toEqual([]);
  });

  it("with a session, still goes to «Главная», as before", async () => {
    api.getSession.mockResolvedValue(SESSION);

    await open("/");

    expect(renderedPage()).toBe("dashboard");
    expect(window.location.pathname).toBe("/dashboard");
  });
});

describe("«Документы» with no history to go back to", () => {
  it("returns a signed-in subscriber to «Главная» through the cabinet's root — not to the sign-in form", async () => {
    // The bot links to `/legal`; opened from it there is nothing to pop.
    api.getSession.mockResolvedValue(SESSION);
    await open("/legal");
    const back = container?.querySelector<HTMLButtonElement>("header button");
    expect(back, container?.textContent ?? "").not.toBeNull();

    await act(async () => {
      back?.click();
    });
    await settle();

    expect(visited, visited.join(" → ")).toContain("/");
    expect(visited.some((url) => url.startsWith("/welcome")), visited.join(" → ")).toBe(false);
    expect(window.location.pathname).toBe("/dashboard");
    expect(renderedPage()).toBe("dashboard");
  });

  it("returns a visitor without a session to the sign-in form", async () => {
    noSession();
    await open("/legal");

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("header button")?.click();
    });
    await settle();

    expect(window.location.pathname).toBe("/sign-in");
    expect(renderedPage()).toBe("sign-in");
  });
});
