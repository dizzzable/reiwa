// @vitest-environment jsdom

/**
 * INSIDE A TELEGRAM MINI APP, AN "ADD TO APP" BUTTON NEVER CARRIES THE APP'S
 * SCHEME.
 *
 * Two recordings from the owner, the same screen, the app installed both times:
 *
 *   - Telegram for Android: the tap loaded `incy://…` in the Mini App's own
 *     webview and Telegram replaced the whole Mini App with its error page —
 *     «Не удалось загрузить 2GET SHOP. net::ERR_UNKNOWN_URL_SCHEME».
 *   - Telegram for iOS: the tap did nothing. The same button in Safari worked.
 *
 * So inside Telegram the button hands Telegram's documented `openLink` the
 * address of the cabinet's trampoline page, and outside Telegram — and in
 * Telegram Desktop, where the owner saw the anchor work — the anchor stays
 * exactly as it was. `web/src/features/connect/deep-link-handoff.ts` has the
 * sources for each client.
 *
 * Every Telegram case is launched the way Telegram launches the cabinet — its
 * parameters in the fragment — and none defines `window.Telegram` unless the
 * case is about the bridge: the SDK arrives from telegram.org, which this
 * product's customers often cannot reach.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readTrampolinePayload } from "@/features/connect/connect-trampoline";
import { deepLinkHandoff } from "@/features/connect/deep-link-handoff";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; V2403A) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36";

/** A live payload — `auth_date` now, so nothing treats the launch as spent. */
const INIT_DATA =
  "user=%7B%22id%22%3A42%7D&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=deadbeef";

const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

const SUBSCRIPTION_URL = "https://sub.example.test/s/AbC123";
const HAPP_HREF = `happ://add/${SUBSCRIPTION_URL}`;
/**
 * An app the shipped catalog does not contain, with a scheme nothing in the
 * cabinet has heard of — which is what the owner's shop runs. The fix may not
 * depend on knowing it.
 */
const OPERATOR_HREF = `shopvpn://import?url=${encodeURIComponent(SUBSCRIPTION_URL)}`;

function app(id: string, name: string, template: string, encode: "raw" | "component", featured: boolean) {
  return {
    id,
    name,
    iconKey: null,
    featured,
    steps: [
      {
        title: { ru: "Добавление подписки" },
        body: null,
        iconKey: null,
        buttons: [
          { kind: "deepLink", label: { ru: "Добавить подписку" }, template, encode },
          { kind: "copyLink", label: { ru: "Скопировать ссылку" } },
        ],
      },
    ],
  };
}

const CATALOG = {
  platforms: [
    {
      id: "android",
      title: { ru: "Android" },
      apps: [
        app("happ", "Happ", "happ://add/{{SUBSCRIPTION_LINK}}", "raw", true),
        app("shop", "Shop VPN", "shopvpn://import?url={{SUBSCRIPTION_LINK}}", "component", false),
      ],
    },
  ],
  icons: {},
  connectScreenEnabled: true,
};

const SUBSCRIPTION = {
  id: "sub-1",
  status: "ACTIVE",
  isTrial: false,
  profileName: "dizzable",
  url: SUBSCRIPTION_URL,
  expiresAt: "2100-02-28T00:00:00.000Z",
  trafficUsed: 1,
  trafficLimit: null,
  deviceLimit: null,
  userRemnaId: null,
  plan: { id: null, name: null, type: null },
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === "connect-page" ? CATALOG : { subscriptions: [SUBSCRIPTION] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client", () => ({ getAllSubscriptions: vi.fn(), getConnectPage: vi.fn() }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({
    branding: { brandName: "2GET SHOP", logoUrl: null, navItems: [] },
    customIcons: {},
  }),
}));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button">back</button>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: ConnectPage } = await import("../src/features/connect/connect-page");
const { usePageBackdropStore } = await import("../src/stores/page-backdrop.store");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<ConnectPage />));
  return host;
}

/** Telegram opened this document: its launch parameters are in the fragment. */
function launchedBy(platform: string): void {
  window.location.hash =
    "#tgWebAppData=" + encodeURIComponent(INIT_DATA) + "&tgWebAppVersion=9.6&tgWebAppPlatform=" + platform;
}

function defineUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, get: () => userAgent });
}

function bridge(extra: Record<string, unknown> = {}): { openLink: ReturnType<typeof vi.fn> } {
  const openLink = vi.fn();
  (window as unknown as Record<string, unknown>).Telegram = {
    WebApp: { openLink, HapticFeedback: { impactOccurred: vi.fn() }, ...extra },
  };
  return { openLink };
}

/** Every `href` on the screen whose scheme is not a browser navigation. */
function appSchemeHrefs(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href));
}

function trampolineButton(el: HTMLElement): HTMLButtonElement {
  const button = el.querySelector<HTMLButtonElement>("button[data-connect-trampoline]");
  expect(button, "no trampoline button was rendered").not.toBeNull();
  return button as HTMLButtonElement;
}

function forget(name: string): void {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, name);
}

function cleanDocument(): void {
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState({}, "", "/subscription/connect");
  window.location.hash = "";
  window.sessionStorage.clear();
  window.localStorage.clear();
  forget("Telegram");
  forget("__reiwaTelegramSdkState");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cleanDocument();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  usePageBackdropStore.setState({ backdrop: null });
  cleanDocument();
  Reflect.deleteProperty(window.navigator, "userAgent");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("outside Telegram the anchor the owner saw working stays", () => {
  it("in Safari on an iPhone", () => {
    defineUserAgent(IPHONE_SAFARI_UA);
    const el = render();

    const anchor = el.querySelector<HTMLAnchorElement>('a[href^="happ://"]');
    expect(anchor?.getAttribute("href")).toBe(HAPP_HREF);
    expect(anchor?.hasAttribute("target"), "the working anchor was changed").toBe(false);
    expect(el.querySelector("button[data-connect-trampoline]")).toBeNull();
    expect(el.textContent).not.toContain("connect.openHint");
  });

  it("in Chrome on an Android phone — the user agent decides nothing", () => {
    defineUserAgent(ANDROID_CHROME_UA);
    const el = render();

    expect(el.querySelector('a[href^="happ://"]')?.getAttribute("href")).toBe(HAPP_HREF);
    expect(el.querySelector("button[data-connect-trampoline]")).toBeNull();
  });
});

describe("inside a Telegram Mini App the app's scheme never reaches an href", () => {
  it.each([
    // Recorded by the owner: the Mini App replaced by an error page.
    "android",
    // Recorded by the owner: nothing happens.
    "ios",
    // Not recorded. Covered by the same rule because a wrong anchor costs the
    // whole Mini App and a wrong trampoline costs one tap.
    "macos",
    "weba",
    "webk",
    "android_x",
    "a-client-nobody-has-heard-of",
  ])("Telegram %s gets the trampoline button", (platform) => {
    defineUserAgent(platform === "ios" ? IPHONE_SAFARI_UA : ANDROID_CHROME_UA);
    launchedBy(platform);
    const el = render();

    expect(
      appSchemeHrefs(el),
      `Telegram ${platform} was handed an app scheme in an href — on Android that navigation destroys the Mini App`,
    ).toEqual([]);
    trampolineButton(el);
    expect(el.textContent).toContain("connect.openHint");
  });

  it("hands openLink the trampoline address from the tap itself", () => {
    launchedBy("android");
    const { openLink } = bridge();
    const el = render();
    const button = trampolineButton(el);

    act(() => {
      button.click();
      // Asserted INSIDE the tap: both mobile clients refuse `openLink` once the
      // touch is ten seconds old, so an await before the call is a defect even
      // when the call eventually happens.
      expect(openLink, "openLink was not called synchronously from the tap").toHaveBeenCalledTimes(1);
    });

    const opened = new URL(String(openLink.mock.calls[0]?.[0]));
    expect(opened.origin).toBe(window.location.origin);
    expect(opened.pathname).toBe("/connect/open");
    // The key is in the fragment and nowhere a server or its log could see it.
    expect(opened.search).toBe("");
    expect(opened.href).not.toContain("sub.example.test");
    expect(readTrampolinePayload(opened.hash)).toEqual({
      link: HAPP_HREF,
      subscriptionUrl: SUBSCRIPTION_URL,
    });
  });

  it("opens the same address as a new window when the bridge never arrived, never in place", () => {
    launchedBy("ios");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const before = window.location.href;
    const el = render();

    act(() => trampolineButton(el).click());

    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0] ?? [];
    expect(readTrampolinePayload(new URL(String(url)).hash)?.link).toBe(HAPP_HREF);
    expect(target).toBe("_blank");
    expect(features).toBe("noopener,noreferrer");
    expect(window.location.href, "the Mini App's own document navigated").toBe(before);
  });

  it("carries an operator's own scheme the same way, keyed on nothing but the catalog", () => {
    launchedBy("android");
    const { openLink } = bridge();
    const el = render();

    act(() => el.querySelector<HTMLButtonElement>("[data-connect-app='shop']")?.click());
    act(() => trampolineButton(el).click());

    const opened = new URL(String(openLink.mock.calls[0]?.[0]));
    expect(readTrampolinePayload(opened.hash)?.link).toBe(OPERATOR_HREF);
  });

  it("still does once the launch payload is gone and only the client description is left", () => {
    // What `forgetTelegramLaunchPayload()` leaves after a 401, and what a reload
    // reads back: the session mirror, with the platform and without the payload.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppPlatform: "android", tgWebAppVersion: "9.6" }),
    );
    const el = render();

    expect(appSchemeHrefs(el)).toEqual([]);
    trampolineButton(el);
  });

  it("treats a bridge with no launch behind it as Telegram — the safe direction", () => {
    // Reading a Mini App as a browser destroys it; reading a browser as a Mini
    // App costs one page. `isTelegramMiniAppSurface()` only moves towards the
    // second mistake.
    bridge();
    const el = render();

    expect(appSchemeHrefs(el)).toEqual([]);
    trampolineButton(el);
  });

  it("never takes the platform from the bridge", () => {
    // If `WebApp.platform` were read, this bridge would unlock the Desktop
    // exception below with no launch parameter saying so.
    bridge({ platform: "tdesktop" });
    const el = render();

    expect(appSchemeHrefs(el)).toEqual([]);
    trampolineButton(el);
  });
});

describe("Telegram Desktop keeps the anchor the owner saw working", () => {
  it("renders the plain same-window anchor and no trampoline", () => {
    launchedBy("tdesktop");
    const el = render();

    expect(el.querySelector('a[href^="happ://"]')?.getAttribute("href")).toBe(HAPP_HREF);
    expect(el.querySelector("button[data-connect-trampoline]")).toBeNull();
    expect(el.textContent).not.toContain("connect.openHint");
  });
});

describe("the decision on its own", () => {
  it("is the anchor outside Telegram whatever the platform says", () => {
    expect(deepLinkHandoff({ insideTelegram: false, telegramPlatform: null })).toBe("anchor");
    expect(deepLinkHandoff({ insideTelegram: false, telegramPlatform: "android" })).toBe("anchor");
  });

  it("is the trampoline inside Telegram for everything but Telegram Desktop", () => {
    for (const platform of [null, "android", "ios", "macos", "weba", "webk", "unknown", ""]) {
      expect(deepLinkHandoff({ insideTelegram: true, telegramPlatform: platform }), String(platform)).toBe(
        "trampoline",
      );
    }
    expect(deepLinkHandoff({ insideTelegram: true, telegramPlatform: "tdesktop" })).toBe("anchor");
  });
});
