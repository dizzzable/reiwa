// @vitest-environment jsdom

/**
 * A deep link survives a PASSWORD sign-in — asked of the real `App.tsx`, its
 * real route table and protected shell, the real `/bootstrap` hop and home page,
 * the real sign-in form and the real change-password page.
 *
 * Every hop on the way to the form already carried the destination as `?next=`
 * — the shell's redirect, `/bootstrap`, the home page, which forwards `next` to
 * `/sign-in` on purpose — and the form itself threw it away: a successful
 * sign-in went to the dashboard, always. So a bot button opened in a browser, a
 * push opened in a new window, a bookmark to `/renew`: sign in, and the page you
 * came for is gone.
 *
 * The order the form now follows, and what each case below pins:
 *   1. a step the SERVER requires — a forced password change, and anything the
 *      login answer names other than its default `/dashboard` — goes first, and
 *      the destination rides along with it;
 *   2. then the destination, checked by the one same-origin rule every hop shares;
 *   3. then the dashboard.
 *
 * Only the network and the leaves are stubbed: the session, login and
 * password-change calls, the pages the flow ends on (probes that name
 * themselves), the form's third-party sign-in buttons, and the shell's chrome.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { BrowserRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  login: vi.fn(),
  changePasswordAuth: vi.fn(),
  botSignin: vi.fn(),
  bootstrapTelegram: vi.fn(),
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
vi.mock("@/features/auth/account-security-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/auth/account-security-api")>()),
  getPasswordState: vi.fn(async () => ({ hasPassword: true })),
}));
// The form's Google / Yandex / Telegram-widget buttons and the guest chat link
// fetch configuration of their own; neither is this file's subject.
vi.mock("@/features/auth/external-auth-buttons", () => ({ ExternalAuthButtons: () => null }));
vi.mock("@/features/support/guest-support-link", () => ({ GuestSupportLink: () => null }));

vi.mock("@/hooks/use-telegram-webapp", () => ({ useTelegramWebApp: () => ({ telegram: null }) }));
vi.mock("@/hooks/use-ad-attribution", () => ({ useAdAttribution: () => undefined }));
vi.mock("@/hooks/use-device-signals", () => ({ useDeviceSignals: () => undefined }));
// A plain browser, decided at once.
vi.mock("@/features/auth/telegram-launch", () => ({ detectTelegramInitData: async () => null }));

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
vi.mock("@/features/renewal/renewal-page", () => page("renew"));
vi.mock("@/features/auth/finish-setup-page", () => page("finish-setup"));

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

const CONNECT_LINK = "/dashboard?connect=help&subscriptionId=cmsub0001abcdefghijklmno";

function signedIn(requiresPasswordChange: boolean): ReiwaSession {
  return {
    id: "cmfa1b2c3d0000reiwa0websubscr",
    telegramId: null,
    name: "Alice",
    role: "USER",
    onboardingCompleted: true,
    webAccount: {
      id: "cmwebaccount0000000000000",
      login: "alice",
      email: null,
      emailVerifiedAt: null,
      requiresPasswordChange,
    },
  };
}

/** What `POST /auth/login` answers: the BFF sets `redirectUrl` itself (`src/api/routes/auth.ts`). */
const ANSWER = {
  plain: { success: true, redirectUrl: "/dashboard", requiresPasswordChange: false },
  forced: { success: true, redirectUrl: "/change-password", requiresPasswordChange: true },
  // Not sent by any server today — the pin for "a step the server requires goes first".
  mandated: { success: true, redirectUrl: "/finish-setup", requiresPasswordChange: false },
} as const;

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

async function open(url: string): Promise<void> {
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

function field(selector: string): HTMLInputElement {
  const input = container?.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no field ${selector} on ${address()}: ${container?.textContent ?? ""}`);
  return input;
}

function type(selector: string, value: string): void {
  const input = field(selector);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitForm(): Promise<void> {
  const form = container?.querySelector("form");
  if (!form) throw new Error(`no form on ${address()}`);
  await act(async () => {
    form.requestSubmit();
  });
  await settle();
}

/** Types a login and password into the real form and sends it; the session exists from then on. */
async function signInAnswering(answer: (typeof ANSWER)[keyof typeof ANSWER]): Promise<void> {
  expect(renderedPage(), `not on the sign-in form: ${address()}`).toBeNull();
  api.login.mockImplementation(async () => {
    api.getSession.mockResolvedValue(signedIn(answer.requiresPasswordChange));
    return answer;
  });
  type('input[name="username"]', "alice");
  type('input[name="password"]', "correct horse battery");
  await submitForm();
  expect(api.login).toHaveBeenCalledTimes(1);
}

/** Changes the password on the real page, then presses «Продолжить» on the save screen. */
async function changePasswordAndContinue(): Promise<void> {
  api.changePasswordAuth.mockImplementation(async () => {
    api.getSession.mockResolvedValue(signedIn(false));
    return { success: true };
  });
  type("#current-password", "correct horse battery");
  type("#new-password", "a brand new passphrase");
  await submitForm();
  expect(api.changePasswordAuth).toHaveBeenCalledTimes(1);
  const label = i18n.t("auth.saveCredentials.continue");
  const button = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no «${label}» on the save screen: ${container?.textContent ?? ""}`);
  await act(async () => {
    button.click();
  });
  await settle();
}

beforeAll(() => {
  // The sign-in form reads it at module scope; jsdom has none.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  // No cabinet cookie until the form signs in.
  api.getSession.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const fn of Object.values(api)) fn.mockReset();
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState(null, "", "/");
});

describe("a deep link survives a password sign-in", () => {
  it("/renew", async () => {
    await open("/renew");
    // Anti-vacuity: the way in really was the form, with the destination on it.
    expect(address()).toBe("/sign-in?next=%2Frenew");

    await signInAnswering(ANSWER.plain);

    expect(address(), "the sign-in went to the dashboard and /renew is gone").toBe("/renew");
    expect(renderedPage()).toBe("renew");
  });

  it("the connect-help link, subscription and all", async () => {
    await open(CONNECT_LINK);
    expect(address()).toBe(`/sign-in?next=${encodeURIComponent(CONNECT_LINK)}`);

    await signInAnswering(ANSWER.plain);

    expect(address()).toBe(CONNECT_LINK);
    expect(renderedPage()).toBe("dashboard");
  });
});

describe("a deep link survives a forced password change on the way", () => {
  it("/renew", async () => {
    await open("/renew");

    await signInAnswering(ANSWER.forced);
    // The server's step first — with the destination riding along.
    expect(address()).toBe("/change-password?next=%2Frenew");

    await changePasswordAndContinue();

    expect(address()).toBe("/renew");
    expect(renderedPage()).toBe("renew");
  });

  it("the connect-help link", async () => {
    await open(CONNECT_LINK);

    await signInAnswering(ANSWER.forced);
    expect(address()).toBe(`/change-password?next=${encodeURIComponent(CONNECT_LINK)}`);

    await changePasswordAndContinue();

    expect(address()).toBe(CONNECT_LINK);
    expect(renderedPage()).toBe("dashboard");
  });
});

describe("a step the server requires still goes first", () => {
  it("wins over the destination, which rides along", async () => {
    await open("/renew");

    await signInAnswering(ANSWER.mandated);

    expect(address(), "the destination overrode a step the server required").toBe(
      "/finish-setup?next=%2Frenew",
    );
    expect(renderedPage()).toBe("finish-setup");
  });
});

describe("a destination that is not one", () => {
  const HOSTILE = [
    "%2F%2Fevil.example%2Fphish",
    "https%3A%2F%2Fevil.example%2Fphish",
    "%2F%5Cevil.example%2Fphish",
    "javascript%3Aalert(1)",
    "%2F%09%2Fevil.example",
  ];

  for (const next of HOSTILE) {
    it(`?next=${next} is dropped: the dashboard, as before`, async () => {
      await open(`/sign-in?next=${next}`);

      await signInAnswering(ANSWER.plain);

      // Straight to the dashboard: not by way of the hostile address and a
      // catch-all route that happens to send everybody home.
      expect(visited, "the form navigated to the hostile destination first").toEqual(["/dashboard"]);
      expect(window.location.origin).toBe("http://localhost:3000");
      expect(address()).toBe("/dashboard");
      expect(renderedPage()).toBe("dashboard");
    });
  }

  it("is dropped on the way to a forced change too", async () => {
    await open(`/sign-in?next=${HOSTILE[0]}`);

    await signInAnswering(ANSWER.forced);

    expect(address()).toBe("/change-password");
  });

  it("leading back to the form itself is no destination either", async () => {
    await open("/sign-in?next=%2Fsign-in");

    await signInAnswering(ANSWER.plain);

    expect(address()).toBe("/dashboard");
    expect(renderedPage()).toBe("dashboard");
  });
});

describe("a sign-in with nowhere else to go", () => {
  it("still lands on the dashboard", async () => {
    await open("/sign-in");

    await signInAnswering(ANSWER.plain);

    expect(address()).toBe("/dashboard");
    expect(renderedPage()).toBe("dashboard");
    expect(visited.some((entry) => entry.includes("next="))).toBe(false);
  });
});
