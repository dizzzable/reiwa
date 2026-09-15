// @vitest-environment jsdom

/**
 * WHICH ROUTES THE CHANNEL WALL COVERS — ASKED OF THE REAL `App.tsx`.
 *
 * `channel-gate.test.tsx` proves what the gate does around a router it is
 * handed. This file proves it is around THIS router: the real `App` renders,
 * with its real route table and the real `ChannelGate` in it, and only the
 * leaves are stubbed — every lazy page is a one-line probe that names itself,
 * the protected shell is a bare `<Outlet />`, and the network answers
 * `/session` and `GET /channel-gate`.
 *
 * So a route that slips out of the gate, or an exemption that stops applying,
 * shows up here as the page or the wall being where it should not be — in a
 * case that also shows the other one where it should.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  getChannelGate: vi.fn(),
  checkChannelGate: vi.fn(),
}));

// The network only: the gate's failure reader stays the real one.
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  ...api,
}));
// No bridge: the SDK never arrived. The shape is the hook's own.
vi.mock("@/hooks/use-telegram-webapp", () => ({ useTelegramWebApp: () => ({ telegram: null }) }));
vi.mock("@/hooks/use-ad-attribution", () => ({ useAdAttribution: () => undefined }));
vi.mock("@/hooks/use-device-signals", () => ({ useDeviceSignals: () => undefined }));
vi.mock("@/components/ui/entry-brand-tile", () => ({ EntryBrandTile: () => <div /> }));
vi.mock("@/components/layout/stealth-layout", async () => {
  const { Outlet } = await import("react-router");
  return { default: () => <Outlet /> };
});

/** A lazy page that says which one it is. */
function page(name: string) {
  return { default: () => <p data-probe="page">{name}</p> };
}
vi.mock("@/features/auth/web-home-page", () => page("web-home"));
vi.mock("@/features/auth/tma-bootstrap-page", () => page("tma"));
vi.mock("@/features/auth/context-router", () => page("context-router"));
vi.mock("@/features/payment/payment-return-page", () => page("payment-return"));
vi.mock("@/features/legal/legal-page", () => page("legal"));
vi.mock("@/features/dashboard/dashboard-page", () => page("dashboard"));
vi.mock("@/features/auth/claim-page", () => page("claim"));
vi.mock("@/features/auth/sign-in-page", () => page("sign-in"));
vi.mock("@/features/onboarding/onboarding-page", () => page("onboarding"));
vi.mock("@/features/support/guest-support-page", () => page("guest-support"));
vi.mock("@/features/connect/connect-open-page", () => page("connect-open"));

import App from "@/App";
import { isChannelGateExemptPath } from "@/features/channel-gate/channel-gate";
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

/** The panel's session as `/session` passes it through (`mapInternalUserSession`): `id`, no `userId`. */
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

function openInMiniApp(): void {
  window.history.replaceState(null, "", "/#tgWebAppVersion=8.0&tgWebAppPlatform=android");
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderApp(path: string): Promise<void> {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["session"], SESSION);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The page the route rendered, by name, or null. */
function renderedPage(): string | null {
  return container?.querySelector('[data-probe="page"]')?.textContent ?? null;
}

function wallIsUp(): boolean {
  return container?.querySelector("h1")?.textContent === ru.channelGate.title;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  api.getSession.mockResolvedValue(SESSION);
  api.getChannelGate.mockResolvedValue({ status: "not-subscribed", joinUrl: "https://t.me/reiwa_news" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queryClient?.clear();
  queryClient = null;
  vi.unstubAllGlobals();
  api.getSession.mockReset();
  api.getChannelGate.mockReset();
  api.checkChannelGate.mockReset();
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState(null, "", "/");
});

describe("App in a plain browser", () => {
  it("renders the cabinet route and never asks the channel gate", async () => {
    window.history.replaceState(null, "", "/dashboard");

    await renderApp("/dashboard");

    expect(renderedPage()).toBe("dashboard");
    expect(wallIsUp()).toBe(false);
    expect(api.getChannelGate).not.toHaveBeenCalled();
    expect(api.checkChannelGate).not.toHaveBeenCalled();
  });
});

describe("App in a Telegram Mini App whose user is not in the channel", () => {
  it.each([
    ["/dashboard", "the protected shell"],
    ["/claim", "a credential gate the shell hands over to"],
    ["/onboarding", "a public cabinet page"],
    ["/sign-in", "a public auth page"],
    ["/support/guest", "anonymous support — public, but not exempt"],
    ["/connect/open", "the connect trampoline — public, but not exempt"],
    ["/no/such/route", "the catch-all"],
  ])("walls %s (%s)", async (path) => {
    openInMiniApp();

    await renderApp(path);

    expect(wallIsUp(), `${path} was not walled`).toBe(true);
    expect(renderedPage(), `${path} rendered behind the wall`).toBeNull();
  });

  it.each([
    ["/", "web-home"],
    ["/tma", "tma"],
    ["/bootstrap", "context-router"],
    ["/payment-return", "payment-return"],
    ["/legal", "legal"],
  ])("leaves %s to render %s", async (path, expected) => {
    openInMiniApp();

    await renderApp(path);

    expect(renderedPage(), `${path} is exempt but did not render`).toBe(expected);
    expect(wallIsUp(), `${path} is exempt but was walled`).toBe(false);
    expect(api.getChannelGate, "the check must still run on an exempt route").toHaveBeenCalledTimes(1);
  });
});

describe("an exempt path is matched the way the router matches it", () => {
  it.each(["/", "/tma", "/bootstrap", "/payment-return", "/legal", "/legal/", "/LEGAL", "/Payment-Return/"])(
    "%s is exempt",
    (pathname) => {
      expect(isChannelGateExemptPath(pathname)).toBe(true);
    },
  );

  it.each([
    "/dashboard",
    "/legalese",
    "/legal/offer",
    "/payment-return/extra",
    "/tma/next",
    "/support/guest",
    "/connect/open",
    "/settings",
  ])("%s is not", (pathname) => {
    expect(isChannelGateExemptPath(pathname)).toBe(false);
  });
});
