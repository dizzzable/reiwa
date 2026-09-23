// @vitest-environment jsdom

/**
 * THE PAGES THE PANEL OFFERS FOR A «MINI APP» BUTTON — ASKED OF THE REAL `App.tsx`.
 *
 * «Карта бота» in the panel lists the cabinet pages a button can open, and the
 * operator picks one. It listed `/subscribe` («Покупка подписки») until
 * 23.09.2026, and the cabinet never had that page: a Mini App opened on a path
 * with no page falls through to the catch-all and shows the home screen, so a
 * button to it looked right in the panel and did nothing a subscriber could
 * tell apart from «the button is broken».
 *
 * The list below is the panel's (`MINI_APP_TERMINALS` in rezeis
 * `src/modules/bot-map/catalogs/mini-app-terminals.catalog.ts`, pinned in its
 * `test/bot-map-composer.service.spec.ts`). Here every one of them is rendered
 * through the real route table, with each page a probe that names itself and
 * the protected shell a bare `<Outlet />`. Change one list, change the other.
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

/** A lazy page that says which one it is, and where the router put it. */
async function probe(name: string) {
  const { useLocation } = await import("react-router");
  return {
    default: function Probe() {
      const location = useLocation();
      return (
        <p data-probe="page" data-location={`${location.pathname}${location.search}`}>
          {name}
        </p>
      );
    },
  };
}
vi.mock("@/features/auth/web-home-page", () => probe("web-home"));
vi.mock("@/features/dashboard/dashboard-page", () => probe("dashboard"));
vi.mock("@/features/auth/open-in-browser-page", () => probe("open-in-browser"));
vi.mock("@/features/subscription/subscription-page", () => probe("subscription"));
vi.mock("@/features/subscription/devices-page", () => probe("devices"));
vi.mock("@/features/connect/connect-page", () => probe("connect"));
vi.mock("@/features/plans/plans-page", () => probe("plans"));
vi.mock("@/features/renewal/renewal-page", () => probe("renew"));
vi.mock("@/features/upgrade/upgrade-page", () => probe("upgrade"));
vi.mock("@/features/addons/addons-page", () => probe("addons"));
vi.mock("@/features/referrals/referrals-page", () => probe("referrals"));
vi.mock("@/features/referrals/points-exchange-page", () => probe("points-exchange"));
vi.mock("@/features/partner/partner-page", () => probe("partner"));
vi.mock("@/features/promo/promo-page", () => probe("promo"));
vi.mock("@/features/wheel/wheel-page", () => probe("wheel"));
vi.mock("@/features/events/events-page", () => probe("events"));
vi.mock("@/features/activity/activity-page", () => probe("activity"));
vi.mock("@/features/settings/settings-page", () => probe("settings"));
vi.mock("@/features/settings/transactions-page", () => probe("transactions"));
vi.mock("@/features/settings/faq-page", () => probe("faq"));
vi.mock("@/features/support/support-page", () => probe("support"));

import App from "@/App";
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

/** The panel's list, in its order, with the page each one must open. */
const MINI_APP_PAGES: ReadonlyArray<readonly [route: string, page: string]> = [
  ["/dashboard", "dashboard"],
  ["/open-in-browser", "open-in-browser"],
  ["/subscription", "subscription"],
  ["/subscription/devices", "devices"],
  ["/subscription/connect", "connect"],
  ["/plans", "plans"],
  ["/renew", "renew"],
  ["/upgrade", "upgrade"],
  ["/addons", "addons"],
  ["/referrals", "referrals"],
  ["/referrals/exchange", "points-exchange"],
  ["/partner", "partner"],
  ["/promo", "promo"],
  ["/wheel", "wheel"],
  ["/events", "events"],
  ["/activity", "activity"],
  ["/settings", "settings"],
  ["/settings/transactions", "transactions"],
  ["/settings/faq", "faq"],
  ["/support", "support"],
];

/** The panel's session as `/session` passes it through: more fields than the type names. */
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

function rendered(): { readonly page: string | null; readonly location: string | null } {
  const found = container?.querySelector<HTMLElement>('[data-probe="page"]') ?? null;
  return { page: found?.textContent ?? null, location: found?.dataset.location ?? null };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  api.getSession.mockResolvedValue(SESSION);
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
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState(null, "", "/");
});

describe("every page the panel offers for a «Mini App» button", () => {
  it.each(MINI_APP_PAGES)("%s opens its own page, not the home screen", async (route, page) => {
    await renderApp(route);
    expect(rendered().page).toBe(page);
  });

  it("is on the list once", () => {
    const routes = MINI_APP_PAGES.map(([route]) => route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe("a path the cabinet has no page for", () => {
  it("is the home screen — what a button to it opened, and why the list above matters", async () => {
    await renderApp("/no/such/page");
    expect(rendered().page).toBe("web-home");
  });

  it("`/subscribe`, the page the panel listed until 23.09.2026, is the plans page — its query kept", async () => {
    await renderApp("/subscribe?code=SALE");
    expect(rendered()).toEqual({ page: "plans", location: "/plans?code=SALE" });
  });
});
