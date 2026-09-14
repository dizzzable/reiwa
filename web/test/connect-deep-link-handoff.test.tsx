// @vitest-environment jsdom

/**
 * INSIDE A TELEGRAM MINI APP, AN "ADD TO APP" BUTTON NEVER CARRIES THE APP'S
 * SCHEME — ON ANY TELEGRAM CLIENT.
 *
 * Three reports from the owner, the same screen, the app installed each time:
 *
 *   - Telegram for Android: the tap loaded `incy://…` in the Mini App's own
 *     webview and Telegram replaced the whole Mini App with its error page —
 *     «Не удалось загрузить 2GET SHOP. net::ERR_UNKNOWN_URL_SCHEME».
 *   - Telegram for iOS: the tap did nothing. The same button in Safari worked.
 *   - Telegram Desktop on Windows, cabinet 0.9.7.42: «Добавить подписку» did
 *     nothing. That build kept the plain anchor there, and Telegram Desktop's
 *     web view refuses every scheme but http, https, tonsite and ton before
 *     Telegram's own code is asked (lib_webview, `webview_embed.cpp:421-429`) —
 *     on Windows, macOS and Linux alike.
 *
 * So inside Telegram the button hands Telegram's documented `openLink` the
 * address of the cabinet's trampoline page — through the SDK when it arrived,
 * through the client's own channel when it did not — and outside Telegram the
 * anchor stays exactly as it was. `web/src/features/connect/deep-link-handoff.ts`
 * has the sources for each client.
 *
 * Every Telegram case is launched the way Telegram launches the cabinet — its
 * parameters in the fragment — and none defines `window.Telegram` unless the
 * case is about the bridge: the SDK arrives from telegram.org, which this
 * product's customers often cannot reach.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readTrampolinePayload, trampolineUrl } from "@/features/connect/connect-trampoline";
import { deepLinkHandoff } from "@/features/connect/deep-link-handoff";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; V2403A) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36";

/**
 * The three web views Telegram Desktop runs a Mini App in. `tdesktop` is one
 * launch parameter for all of them, and the cabinet no longer tells them apart:
 * the user agents are here so each system is rendered in its own, and so the
 * one 0.9.7.42 read — Windows, which is WebView2, which is Edge — is shown to
 * earn nothing. All three refuse an app scheme in lib_webview.
 */
const TDESKTOP_WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0";
/** macOS: WKWebView's own user agent, which carries no Safari token. */
const TDESKTOP_MACOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
/** Linux: WebKitGTK. */
const TDESKTOP_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/** A live payload — `auth_date` now, so nothing treats the launch as spent. */
const INIT_DATA =
  "user=%7B%22id%22%3A42%7D&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=deadbeef";

const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

const SUBSCRIPTION_URL = "https://sub.example.test/s/AbC123";
/**
 * What `GET /subscriptions/all` puts on a subscription with a url. Any 32 bytes
 * in base64url do here: this screen carries the signature, it never checks it.
 */
const CONNECT_SIGNATURE = "0q0EVtTmeAZtN1hAS6FIHMEp9upFASpBB7mUNL77xBY";
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
  connectSignature: CONNECT_SIGNATURE,
  expiresAt: "2100-02-28T00:00:00.000Z",
  trafficUsed: 1,
  trafficLimit: null,
  deviceLimit: null,
  userRemnaId: null,
  plan: { id: null, name: null, type: null },
};

/** The row the screen is showing; a case may swap it before rendering. */
let shownSubscription: Record<string, unknown> = SUBSCRIPTION;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === "connect-page" ? CATALOG : { subscriptions: [shownSubscription] },
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

/**
 * The client's own end of the bridge, without the SDK: what Telegram Desktop on
 * Windows and macOS, Android and iOS inject into the Mini App's document.
 */
function webviewProxy(): ReturnType<typeof vi.fn> {
  const postEvent = vi.fn();
  (window as unknown as Record<string, unknown>).TelegramWebviewProxy = { postEvent };
  return postEvent;
}

/** What a Telegram shell reads from the Mini App's frame: `openLink`'s own event. */
function openLinkMessage(url: string): string {
  return JSON.stringify({ eventType: "web_app_open_link", eventData: { url } });
}

/** `location.ancestorOrigins` as an engine reports it: the parent's origin first. */
function domStringList(origins: readonly string[]): DOMStringList {
  return Object.assign([...origins], {
    item: (index: number): string | null => origins[index] ?? null,
    contains: (origin: string): boolean => origins.includes(origin),
  }) as unknown as DOMStringList;
}

/**
 * A Mini App in a frame — Telegram Web, Telegram Desktop for Linux — of a parent
 * on `parentOrigin`, with no proxy.
 *
 * The parent's `postMessage` keeps the browser's rule: a message whose target
 * origin is neither `*` nor the parent's own origin is dropped without a trace,
 * so `received`, not the call count, says whether the shell got the event.
 * `ancestorOrigins` is what the engine says about the parent: `"reported"` as
 * Chromium, WebKit (WebKitGTK included) and Firefox 148+ do, `"absent"` as
 * Firefox before 148 does.
 */
function framedBy(
  parentOrigin: string,
  ancestorOrigins: "reported" | "absent",
): { postMessage: ReturnType<typeof vi.fn>; received: unknown[] } {
  const received: unknown[] = [];
  const postMessage = vi.fn((message: unknown, targetOrigin: string) => {
    if (targetOrigin === "*" || new URL(targetOrigin).origin === parentOrigin) received.push(message);
  });
  vi.stubGlobal("parent", { postMessage });
  if (ancestorOrigins === "reported") {
    Object.defineProperty(window.location, "ancestorOrigins", {
      configurable: true,
      value: domStringList([parentOrigin]),
    });
  }
  return { postMessage, received };
}

/** The trampoline address the Happ button on this screen opens. */
function happTrampoline(): string {
  return trampolineUrl(window.location.origin, {
    link: HAPP_HREF,
    subscriptionUrl: SUBSCRIPTION_URL,
    signature: CONNECT_SIGNATURE,
  });
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
  forget("TelegramWebviewProxy");
  forget("__reiwaTelegramSdkState");
  Reflect.deleteProperty(window.location, "ancestorOrigins");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  shownSubscription = SUBSCRIPTION;
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
    // With the subscription's signature beside it, or the page opens nothing.
    expect(readTrampolinePayload(opened.hash)).toEqual({
      link: HAPP_HREF,
      subscriptionUrl: SUBSCRIPTION_URL,
      signature: CONNECT_SIGNATURE,
    });
  });

  it("offers no button for a subscription that arrived without a signature — and never the anchor instead", () => {
    // An API older than this screen. The trampoline page would refuse the
    // payload, and falling back to the plain anchor is exactly what destroys a
    // Mini App on Android.
    shownSubscription = { ...SUBSCRIPTION, connectSignature: undefined };
    launchedBy("android");
    const el = render();

    expect(appSchemeHrefs(el), "a missing signature put the app scheme back in an href").toEqual([]);
    expect(el.querySelector("button[data-connect-trampoline]")).toBeNull();
    // The rest of the step is still there: the copy button needs no signature.
    expect(el.textContent).toContain("Скопировать ссылку");
  });

  it("opens the same address as a new window when neither the SDK nor the client's channel is there, never in place", () => {
    // No `window.Telegram`, no `TelegramWebviewProxy`, not a frame: the last
    // way out, and it must still leave the Mini App's own document alone.
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

  it("gives a bridge that says tdesktop, in WebView2's user agent, the trampoline too", () => {
    // Everything 0.9.7.42's Desktop exception keyed on, arriving through the
    // bridge instead of the launch parameters. Nothing a host says about itself
    // earns a Mini App the anchor any more, from either source.
    defineUserAgent(TDESKTOP_WINDOWS_UA);
    bridge({ platform: "tdesktop" });
    const el = render();

    expect(appSchemeHrefs(el)).toEqual([]);
    trampolineButton(el);
  });
});

describe("Telegram Desktop takes the trampoline on every system: its web view refuses an app scheme", () => {
  it.each([
    // The owner's report on 0.9.7.42, which rendered the anchor here: WebView2's
    // `NavigationStarting` is cancelled by lib_webview's scheme allowlist, and
    // nothing happens.
    ["Windows", TDESKTOP_WINDOWS_UA],
    // The same allowlist answers WKWebView with a Cancel. Not recorded on a device.
    ["macOS", TDESKTOP_MACOS_UA],
    // The same allowlist ignores the WebKitGTK navigation. Not recorded on a device.
    ["Linux", TDESKTOP_LINUX_UA],
  ])("renders no app-scheme href on %s, and its button hands openLink the trampoline", (os, userAgent) => {
    defineUserAgent(userAgent);
    launchedBy("tdesktop");
    const { openLink } = bridge();
    const el = render();

    expect(
      appSchemeHrefs(el),
      `Telegram Desktop on ${os} was handed an app scheme in an href — its web view refuses it and the button does nothing`,
    ).toEqual([]);
    expect(el.querySelector('a[href^="happ://"]'), `a happ:// anchor was rendered on ${os}`).toBeNull();
    expect(el.textContent).toContain("connect.openHint");

    act(() => trampolineButton(el).click());
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(readTrampolinePayload(new URL(String(openLink.mock.calls[0]?.[0])).hash)?.link).toBe(HAPP_HREF);
  });

  it("writes openLink's own event to TelegramWebviewProxy when the SDK never arrived — the owner's Windows case", () => {
    // No `window.Telegram`: telegram.org is what this product's customers cannot
    // reach. Telegram Desktop injects the proxy itself, and `web_app_open_link`
    // through it opens the system browser with no gesture check at all.
    defineUserAgent(TDESKTOP_WINDOWS_UA);
    launchedBy("tdesktop");
    const postEvent = webviewProxy();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const before = window.location.href;
    const el = render();
    const button = trampolineButton(el);

    act(() => {
      button.click();
      // Inside the tap, as for `openLink`: nothing may be awaited first.
      expect(postEvent, "web_app_open_link was not posted synchronously from the tap").toHaveBeenCalledTimes(1);
    });

    expect(postEvent).toHaveBeenCalledWith("web_app_open_link", JSON.stringify({ url: happTrampoline() }));
    const { url } = JSON.parse(String(postEvent.mock.calls[0]?.[1])) as { url: string };
    expect(url.startsWith(`${window.location.origin}/connect/open#`), url).toBe(true);
    expect(readTrampolinePayload(new URL(url).hash)).toEqual({
      link: HAPP_HREF,
      subscriptionUrl: SUBSCRIPTION_URL,
      signature: CONNECT_SIGNATURE,
    });
    expect(open, "the proxy took the link and a second window was opened anyway").not.toHaveBeenCalled();
    expect(window.location.href, "the Mini App's own document navigated").toBe(before);
  });

  it("posts the same event to Telegram's web shell, and to nobody else, where the Mini App is a frame — Linux", () => {
    // Telegram Desktop for Linux loads the Mini App into a frame of its shell
    // page on https://web.telegram.org, whose frame gets no proxy. WebKitGTK
    // names that parent in `location.ancestorOrigins`.
    defineUserAgent(TDESKTOP_LINUX_UA);
    launchedBy("tdesktop");
    const frame = framedBy("https://web.telegram.org", "reported");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const el = render();
    const button = trampolineButton(el);

    act(() => {
      button.click();
      expect(frame.postMessage, "web_app_open_link was not posted synchronously from the tap").toHaveBeenCalledTimes(1);
    });

    // An explicit target origin, never "*": the message carries a signed
    // subscription link.
    expect(frame.postMessage).toHaveBeenCalledWith(openLinkMessage(happTrampoline()), "https://web.telegram.org");
    expect(frame.received, "the shell never received the button's event").toEqual([openLinkMessage(happTrampoline())]);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not let a Windows user agent make a browser tab Telegram", () => {
    // No launch parameters and no bridge: Edge on a Windows desktop, where the
    // anchor is right. The user agent never decides "inside Telegram".
    defineUserAgent(TDESKTOP_WINDOWS_UA);
    const el = render();

    expect(el.querySelector('a[href^="happ://"]')?.getAttribute("href")).toBe(HAPP_HREF);
    expect(el.querySelector("button[data-connect-trampoline]")).toBeNull();
  });
});

describe("Telegram Web gets the button's event on each host it is served from, without the SDK", () => {
  // Web K is served from web.telegram.org/k/ and from webk.telegram.org — its
  // own config lists both domains — and Web A from web.telegram.org/a/ and from
  // weba.telegram.org, where a signed-in Web A stays. An event addressed to
  // web.telegram.org alone never reaches a shell on either of the other two: the
  // browser drops it without a trace, and the tap that reported it handed over
  // opened nothing at all.

  it("delivers it to Telegram Web K on webk.telegram.org, addressed to that origin, from the tap itself", () => {
    launchedBy("webk");
    const frame = framedBy("https://webk.telegram.org", "reported");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const el = render();
    const button = trampolineButton(el);

    act(() => {
      button.click();
      expect(frame.postMessage, "web_app_open_link was not posted synchronously from the tap").toHaveBeenCalledTimes(1);
    });

    expect(frame.received, "Telegram Web K never received the button's event").toEqual([
      openLinkMessage(happTrampoline()),
    ]);
    expect(frame.postMessage).toHaveBeenCalledWith(openLinkMessage(happTrampoline()), "https://webk.telegram.org");
    expect(open, "the shell took the link and a new window was opened as well").not.toHaveBeenCalled();
  });

  it("delivers it exactly once to Telegram Web A on weba.telegram.org in a browser that cannot name the parent", () => {
    // Firefox before 148 has no `location.ancestorOrigins`: one post per
    // Telegram shell origin, and the parent, which has one origin, receives one.
    launchedBy("weba");
    const frame = framedBy("https://weba.telegram.org", "absent");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const el = render();

    act(() => trampolineButton(el).click());

    expect(frame.postMessage).toHaveBeenCalledTimes(3);
    expect(frame.received, "Telegram Web A did not receive the button's event exactly once").toEqual([
      openLinkMessage(happTrampoline()),
    ]);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the decision on its own", () => {
  // Everything a host could say about itself, including the platform and the
  // user agent 0.9.7.42's exception read. The hosts are handed over whole, so
  // an exception that reads either of them again — in any shape — fails here.
  const PLATFORMS = [null, "tdesktop", "android", "ios", "macos", "weba", "webk", "unknown", "a-client-nobody-has-heard-of", ""];
  const USER_AGENTS = [
    "",
    TDESKTOP_WINDOWS_UA,
    TDESKTOP_MACOS_UA,
    TDESKTOP_LINUX_UA,
    IPHONE_SAFARI_UA,
    ANDROID_CHROME_UA,
    "Mozilla/5.0 (win32) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/29.1.1",
  ];

  function hosts(insideTelegram: boolean) {
    return PLATFORMS.flatMap((telegramPlatform) =>
      USER_AGENTS.map((userAgent) => ({ insideTelegram, telegramPlatform, userAgent })),
    );
  }

  it("is the anchor outside Telegram whatever the platform or the user agent says", () => {
    for (const host of hosts(false)) {
      expect(deepLinkHandoff(host), `${host.telegramPlatform} / ${host.userAgent}`).toBe("anchor");
    }
  });

  it("is the trampoline inside Telegram for every platform and user agent — Telegram Desktop on Windows included", () => {
    const tdesktopOnWindows = { insideTelegram: true, telegramPlatform: "tdesktop", userAgent: TDESKTOP_WINDOWS_UA };
    expect(deepLinkHandoff(tdesktopOnWindows), "Telegram Desktop on Windows got the anchor back").toBe("trampoline");
    for (const host of hosts(true)) {
      expect(deepLinkHandoff(host), `${host.telegramPlatform} / ${host.userAgent}`).toBe("trampoline");
    }
  });
});
