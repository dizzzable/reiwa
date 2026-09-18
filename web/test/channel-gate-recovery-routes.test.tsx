// @vitest-environment jsdom

/**
 * PASSWORD RECOVERY IS NOT BEHIND THE CHANNEL WALL — ASKED OF THE REAL `App.tsx`.
 *
 * A reset link is single-use and lives fifteen minutes, and it is often opened
 * inside Telegram. If the wall stood in front of `/reset-password`, the link
 * would be spent on a screen that asks to join a channel first. Getting back
 * into the WEB cabinet is outside the gate by the owner's decision of
 * 14.09.2026, and the bot's `pwreset` start makes the same exception.
 *
 * The harness is `channel-gate-app-routes.test.tsx`'s: the real `App`, its real
 * route table and `ChannelGate`, leaves stubbed as probes that name themselves,
 * and a Mini App whose user is not in the channel.
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
vi.mock("@/features/auth/recover-page", () => page("recover"));
vi.mock("@/features/auth/recover-subscription-page", () => page("recover-subscription"));
vi.mock("@/features/auth/reset-password-page", () => page("reset-password"));
vi.mock("@/features/auth/sign-in-page", () => page("sign-in"));
vi.mock("@/features/dashboard/dashboard-page", () => page("dashboard"));

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

/** The panel's session as `/session` passes it through: `id`, no `userId`. */
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
  // Inside the Mini App: Telegram's launch parameters in the fragment.
  window.history.replaceState(null, "", "/#tgWebAppVersion=8.0&tgWebAppPlatform=android");
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

describe("password recovery in a Telegram Mini App whose user is not in the channel", () => {
  it.each([
    ["/reset-password", "reset-password"],
    ["/recover", "recover"],
    ["/recover/subscription", "recover-subscription"],
  ])("leaves %s to render %s", async (path, expected) => {
    await renderApp(path);

    expect(renderedPage(), `${path} is exempt but did not render`).toBe(expected);
    expect(wallIsUp(), `${path} is exempt but was walled`).toBe(false);
  });

  it("still walls the cabinet the reset leads into", async () => {
    await renderApp("/dashboard");

    expect(wallIsUp()).toBe(true);
    expect(renderedPage()).toBeNull();
  });
});

describe("the recovery exemptions are exact", () => {
  it.each(["/reset-password", "/reset-password/", "/recover", "/Recover/", "/recover/subscription"])(
    "%s is exempt",
    (pathname) => {
      expect(isChannelGateExemptPath(pathname)).toBe(true);
    },
  );

  it.each(["/reset-password/extra", "/recover/other", "/recovery", "/recover/subscription/x"])("%s is not", (pathname) => {
    expect(isChannelGateExemptPath(pathname)).toBe(false);
  });
});
