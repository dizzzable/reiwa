// @vitest-environment jsdom

/**
 * `openExternalUrl` REACHES TELEGRAM WITHOUT THE SDK.
 *
 * The SDK is ~100 KB from telegram.org, the host this product's customers
 * cannot reach, and the connect screen's trampoline button, the "Open payment"
 * button and every other external link go through this one function. It used
 * to have two answers: the SDK's bridge, whose failure it ignored — the tap
 * ended with nothing opened — and `window.open`.
 *
 * The bridge the SDK writes to is not the SDK's. The client provides it:
 * `window.TelegramWebviewProxy` in Telegram Desktop on Windows and macOS, in
 * Android and in iOS, and the parent frame's `postMessage` where the Mini App is
 * a frame — Telegram Web, Telegram Desktop for Linux. `telegram-web-app.js`
 * sends `openLink` as a `web_app_open_link` event through one of those, and so
 * does `openExternalUrl` when the SDK is missing or refused.
 *
 * Two things must never go through that channel: a scheme other than http and
 * https (Telegram Desktop closes the Mini App on one), and anything at all from
 * a document that is not a Mini App.
 *
 * Two ways the channel itself went wrong, both only without the SDK:
 *
 *   - A frame's event was addressed to `https://web.telegram.org` alone. Telegram
 *     Web K is also served from `https://webk.telegram.org` and Web A from
 *     `https://weba.telegram.org`, and a browser DROPS a message whose target
 *     origin is not the parent's — no exception, no event. The function still
 *     reported the event handed over, so `openExternalUrl` skipped `window.open`
 *     and the tap opened nothing. The parent's `postMessage` below keeps that
 *     browser rule (`framedBy`), so a post to the wrong shell no longer passes
 *     for a delivered one.
 *   - Only `t.me` was held back from the channel. Telegram Desktop resolves
 *     `telegram.me`, `telegram.dog`, their `www.` forms and `<name>.t.me` inside
 *     the client as well — from `window.open`, whose navigation it inspects, and
 *     never from `web_app_open_link`, which it hands to the system browser.
 *
 * Every Mini App case is launched the way Telegram launches the cabinet — the
 * parameters in the fragment — and defines `window.Telegram` only when the case
 * is about the SDK. Every assertion follows the call with nothing awaited: the
 * mobile clients refuse an open long after the last touch, so an asynchronous
 * hop here would be a defect even if the event were posted in the end.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";
import { openExternalUrl } from "@/lib/utils";

/** A live payload — `auth_date` now, so nothing treats the launch as spent. */
const INIT_DATA = "user=%7B%22id%22%3A42%7D&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=deadbeef";

/** What the connect screen's button hands over inside a Mini App. */
const TRAMPOLINE = "https://cabinet.example.test/connect/open#eyJsaW5rIjoiaGFwcDovL2FkZC94In0";
/** An ordinary web gateway, which "Open payment" hands over. */
const WEB_GATEWAY = "https://pay.example/abc";
/** A Telegram Stars invoice — only `openInvoice` can take the payment. */
const STARS_INVOICE = "https://t.me/$sTaRs-InVoIcE_1=";
/** A CryptoPay bot deep link. */
const CRYPTO_BOT = "https://t.me/CryptoBot?start=IVxyz123";
/** An app's own scheme — what the connect screen must never hand to the bridge. */
const HAPP = "happ://add/https://sub.example.test/s/AbC123";

/**
 * The origins a Mini App's parent frame is served from by Telegram itself:
 * Telegram Web (`/k/` and `/a/`) and Telegram Desktop for Linux's shell page on
 * `web.telegram.org`, Web K on its own host, Web A on its own host.
 */
const TELEGRAM_WEB_ORIGINS = ["https://web.telegram.org", "https://webk.telegram.org", "https://weba.telegram.org"];

/**
 * A link on every host Telegram Desktop resolves inside the client, in each form
 * `TryConvertUrlToLocal` (`core/local_url_handlers.cpp`) accepts:
 * `(www\.)?(telegram\.(me|dog)|t\.me)/…`, case-insensitive and on http too, and
 * a `<name>.t.me` subdomain.
 */
const TELEGRAM_HOST_LINKS = [
  STARS_INVOICE,
  CRYPTO_BOT,
  "https://telegram.me/$sTaRs-InVoIcE_1=",
  "https://telegram.me/CryptoBot?start=IVxyz123",
  "https://telegram.dog/CryptoBot?start=IVxyz123",
  "https://www.t.me/CryptoBot?start=IVxyz123",
  "https://www.telegram.me/CryptoBot?start=IVxyz123",
  "https://www.telegram.dog/CryptoBot?start=IVxyz123",
  "https://durov.t.me/",
  "https://durov.t.me/42",
  "http://telegram.me/CryptoBot?start=IVxyz123",
  "https://Telegram.Dog/CryptoBot?start=IVxyz123",
];

function launchedBy(platform: string): void {
  window.location.hash =
    "#tgWebAppData=" + encodeURIComponent(INIT_DATA) + "&tgWebAppVersion=9.6&tgWebAppPlatform=" + platform;
}

/** The client's own end of the bridge, as Telegram Desktop, Android and iOS inject it. */
function webviewProxy(postEvent: ReturnType<typeof vi.fn> = vi.fn()): ReturnType<typeof vi.fn> {
  (window as unknown as Record<string, unknown>).TelegramWebviewProxy = { postEvent };
  return postEvent;
}

/** What a Telegram shell reads from the frame: `openLink`'s own event. */
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

type Frame = {
  /** Every `postMessage` this document made to its parent, delivered or not. */
  postMessage: ReturnType<typeof vi.fn>;
  /** What the parent actually received. */
  received: unknown[];
};

/**
 * This document as a frame of a parent on `parentOrigin`, with no proxy.
 *
 * The parent's `postMessage` keeps the browser's rule: a message whose target
 * origin is neither `*` nor the parent's own origin is dropped, silently, and
 * only `received` tells the two apart. `ancestorOrigins` is what the engine
 * says about the parent — `"reported"` as Chromium, WebKit and Firefox 148+ do,
 * `"absent"` as Firefox before 148 does (and jsdom, so an unstubbed document is
 * that engine here), `"masked"` as an engine does for a parent whose frame
 * carries `referrerpolicy="no-referrer"`: `"null"`, while the browser still
 * delivers by the parent's real origin.
 */
function framedBy(parentOrigin: string, ancestorOrigins: "reported" | "absent" | "masked"): Frame {
  const received: unknown[] = [];
  const postMessage = vi.fn((message: unknown, targetOrigin: string) => {
    if (targetOrigin === "*" || new URL(targetOrigin).origin === parentOrigin) received.push(message);
  });
  vi.stubGlobal("parent", { postMessage });
  if (ancestorOrigins !== "absent") {
    Object.defineProperty(window.location, "ancestorOrigins", {
      configurable: true,
      value: domStringList([ancestorOrigins === "masked" ? "null" : parentOrigin]),
    });
  }
  return { postMessage, received };
}

type SdkSpies = {
  openLink: ReturnType<typeof vi.fn>;
  openTelegramLink: ReturnType<typeof vi.fn>;
  openInvoice: ReturnType<typeof vi.fn>;
};

/**
 * The SDK, arrived. Its URL checks are the real ones in spirit: `openLink` and
 * `openTelegramLink` throw `WebAppTgUrlInvalid` for anything but http and https.
 */
function withSdk(): SdkSpies {
  const refuseNonHttp = (url: string): void => {
    if (!/^https?:/i.test(url)) throw new Error("WebAppTgUrlInvalid");
  };
  const spies: SdkSpies = {
    openLink: vi.fn(refuseNonHttp),
    openTelegramLink: vi.fn(refuseNonHttp),
    openInvoice: vi.fn(),
  };
  (window as unknown as Record<string, unknown>).Telegram = { WebApp: { ...spies } };
  return spies;
}

function forget(name: string): void {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, name);
}

function cleanDocument(): void {
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState({}, "", "/");
  window.location.hash = "";
  window.sessionStorage.clear();
  forget("Telegram");
  forget("TelegramWebviewProxy");
  forget("__reiwaTelegramSdkState");
  Reflect.deleteProperty(window.location, "ancestorOrigins");
}

let open: MockInstance<typeof window.open>;

beforeEach(() => {
  cleanDocument();
  open = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanDocument();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inside a Mini App the SDK never reached", () => {
  it("writes web_app_open_link to TelegramWebviewProxy, and opens nothing else", () => {
    launchedBy("tdesktop");
    const postEvent = webviewProxy();

    openExternalUrl(TRAMPOLINE);

    expect(postEvent, "web_app_open_link did not reach the proxy").toHaveBeenCalledTimes(1);
    expect(postEvent).toHaveBeenCalledWith("web_app_open_link", JSON.stringify({ url: TRAMPOLINE }));
    expect(open, "the proxy took the link and a new window was opened as well").not.toHaveBeenCalled();
  });

  it("gives the manual payment button the same channel", () => {
    launchedBy("ios");
    const postEvent = webviewProxy();

    openExternalUrl(WEB_GATEWAY);

    expect(postEvent).toHaveBeenCalledWith("web_app_open_link", JSON.stringify({ url: WEB_GATEWAY }));
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to a new tab where there is neither a proxy nor a parent frame", () => {
    launchedBy("ios");

    openExternalUrl(TRAMPOLINE);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(TRAMPOLINE, "_blank", "noopener,noreferrer");
  });

  it("falls back to a new tab when the proxy throws, instead of ending the tap on an exception", () => {
    launchedBy("android");
    webviewProxy(
      vi.fn(() => {
        throw new Error("proxy gone");
      }),
    );

    expect(() => openExternalUrl(TRAMPOLINE)).not.toThrow();
    expect(open).toHaveBeenCalledWith(TRAMPOLINE, "_blank", "noopener,noreferrer");
  });

  it.each([HAPP, "tg://resolve?domain=Bot"])(
    "never hands %s to the proxy — Telegram Desktop closes the Mini App on a scheme it does not allow",
    (url) => {
      launchedBy("tdesktop");
      const postEvent = webviewProxy();

      openExternalUrl(url);

      expect(postEvent, `${url} was posted as web_app_open_link`).not.toHaveBeenCalled();
      // The tap is not dropped: the new tab it got before this channel existed.
      expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    },
  );

  it.each([HAPP, "tg://resolve?domain=Bot"])("never posts %s to the parent frame either", (url) => {
    launchedBy("weba");
    const frame = framedBy("https://web.telegram.org", "reported");

    openExternalUrl(url);

    expect(frame.postMessage, `${url} was posted to the parent frame`).not.toHaveBeenCalled();
  });

  it.each(TELEGRAM_HOST_LINKS)(
    "keeps %s off web_app_open_link and opens it in a new tab — Telegram Desktop resolves that host inside the client",
    (url) => {
      // Telegram Desktop hands `web_app_open_link` straight to the system browser
      // (`Panel::openExternalLink` → `File::OpenUrl`), where a Telegram link is a
      // landing page and a Stars invoice cannot be paid. `window.open` reaches
      // its navigation handler instead, which resolves every one of these hosts
      // natively (`botHandleLocalUri` → `TryConvertUrlToLocal`) — what they all
      // got before the channel existed.
      launchedBy("tdesktop");
      const postEvent = webviewProxy();

      openExternalUrl(url);

      expect(
        postEvent,
        `${url} was posted as web_app_open_link, which Telegram Desktop opens in the system browser`,
      ).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    },
  );

  it.each(TELEGRAM_HOST_LINKS)("does not post %s to a Telegram shell's frame either", (url) => {
    launchedBy("tdesktop");
    const frame = framedBy("https://web.telegram.org", "reported");

    openExternalUrl(url);

    expect(frame.postMessage, `${url} was posted to the parent frame`).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  });

  it.each([
    "https://t.me.evil.example/$sTaRs-InVoIcE_1=",
    "https://telegram.me.evil.example/CryptoBot",
    "https://nott.me/CryptoBot",
    "https://evilt.me/CryptoBot",
    "https://telegram.org/faq",
  ])("still hands %s to the client — only Telegram's own link hosts are held back", (url) => {
    launchedBy("tdesktop");
    const postEvent = webviewProxy();

    openExternalUrl(url);

    expect(postEvent).toHaveBeenCalledWith("web_app_open_link", JSON.stringify({ url: new URL(url).href }));
    expect(open).not.toHaveBeenCalled();
  });
});

describe("inside a Mini App the SDK never reached, in a frame — Telegram Web, Telegram Desktop for Linux", () => {
  it.each([
    ["https://web.telegram.org", "weba"],
    ["https://webk.telegram.org", "webk"],
    ["https://weba.telegram.org", "weba"],
  ])(
    "delivers web_app_open_link to a parent on %s, addressed to that origin alone, where the engine names the parent",
    (origin, platform) => {
      launchedBy(platform);
      const frame = framedBy(origin, "reported");

      openExternalUrl(TRAMPOLINE);

      expect(frame.received, `the shell on ${origin} never received web_app_open_link`).toEqual([
        openLinkMessage(TRAMPOLINE),
      ]);
      // An explicit target origin, never "*": the message carries a signed
      // subscription link.
      expect(frame.postMessage).toHaveBeenCalledTimes(1);
      expect(frame.postMessage).toHaveBeenCalledWith(openLinkMessage(TRAMPOLINE), origin);
      expect(open, "the shell took the link and a new window was opened as well").not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an embedder that is not Telegram", "https://example.com"],
    ["a telegram.org host that is no client", "https://oauth.telegram.org"],
    ["a look-alike host", "https://web.telegram.org.evil.example"],
    ["Telegram Web's host over http", "http://web.telegram.org"],
    ["Telegram Web's host on another port", "https://web.telegram.org:8443"],
  ])("opens a new tab instead, posting nothing, for a parent that is %s (%s)", (_parent, origin) => {
    launchedBy("weba");
    const frame = framedBy(origin, "reported");

    openExternalUrl(TRAMPOLINE);

    expect(frame.postMessage, `web_app_open_link was posted to a parent on ${origin}`).not.toHaveBeenCalled();
    // A post nobody receives must not pass for a delivered one: the tap still
    // opens the link, from the gesture it was made in.
    expect(open, "nothing received the link and nothing else opened it").toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(TRAMPOLINE, "_blank", "noopener,noreferrer");
  });

  it.each([
    ["https://web.telegram.org", "weba"],
    ["https://webk.telegram.org", "webk"],
    ["https://weba.telegram.org", "weba"],
  ])(
    "posts once to each Telegram shell where the engine cannot name the parent — Firefox before 148 — and a parent on %s receives one",
    (origin, platform) => {
      launchedBy(platform);
      const frame = framedBy(origin, "absent");

      openExternalUrl(TRAMPOLINE);

      expect(frame.postMessage, "not one post per Telegram shell").toHaveBeenCalledTimes(TELEGRAM_WEB_ORIGINS.length);
      expect(frame.postMessage.mock.calls.map(([, target]) => String(target)).sort()).toEqual(
        [...TELEGRAM_WEB_ORIGINS].sort(),
      );
      for (const [message] of frame.postMessage.mock.calls) expect(message).toBe(openLinkMessage(TRAMPOLINE));
      expect(frame.received, `the shell on ${origin} did not receive web_app_open_link exactly once`).toEqual([
        openLinkMessage(TRAMPOLINE),
      ]);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("never delivers the link to a parent it cannot name that is not a Telegram shell — never addressed to *", () => {
    // The price of an engine without `ancestorOrigins`: the parent cannot be
    // checked, so the three posts go out and none arrives — and nothing else
    // opens the link in that frame.
    launchedBy("weba");
    const frame = framedBy("https://example.com", "absent");

    openExternalUrl(TRAMPOLINE);

    expect(frame.postMessage).toHaveBeenCalledTimes(TELEGRAM_WEB_ORIGINS.length);
    for (const [, target] of frame.postMessage.mock.calls) expect(TELEGRAM_WEB_ORIGINS).toContain(target);
    expect(frame.received, "a parent that is not a Telegram shell received the signed link").toEqual([]);
  });

  it.each([
    ["https://web.telegram.org", "tdesktop"],
    ["https://webk.telegram.org", "webk"],
    ["https://weba.telegram.org", "weba"],
  ])(
    "still delivers web_app_open_link to a shell on %s that hides its origin — Telegram Desktop for Linux once WebKitGTK masks it",
    (origin, platform) => {
      // Its shell frames the Mini App with `referrerpolicy="no-referrer"`, which
      // since whatwg/html#11560 reads as "null" in `ancestorOrigins`. Taking that
      // for a stranger sent the tap to `window.open` instead of the channel.
      launchedBy(platform);
      const frame = framedBy(origin, "masked");

      openExternalUrl(TRAMPOLINE);

      expect(frame.received, `the masked shell on ${origin} never received web_app_open_link`).toEqual([
        openLinkMessage(TRAMPOLINE),
      ]);
      expect(frame.postMessage).toHaveBeenCalledTimes(TELEGRAM_WEB_ORIGINS.length);
      for (const [, target] of frame.postMessage.mock.calls) expect(TELEGRAM_WEB_ORIGINS).toContain(target);
      expect(open, "the shell took the link and a new window was opened as well").not.toHaveBeenCalled();
    },
  );

  it("never delivers the link to a masked parent that is not a Telegram shell — never addressed to *", () => {
    launchedBy("weba");
    const frame = framedBy("https://oauth.telegram.org", "masked");

    openExternalUrl(TRAMPOLINE);

    // Posted — to the three shells and nowhere else — and received by nobody.
    expect(frame.postMessage).toHaveBeenCalledTimes(TELEGRAM_WEB_ORIGINS.length);
    for (const [, target] of frame.postMessage.mock.calls) expect(TELEGRAM_WEB_ORIGINS).toContain(target);
    expect(frame.received, "a masked parent that is not a Telegram shell received the signed link").toEqual([]);
  });
});

describe("inside a Mini App with the SDK", () => {
  it("leaves the proxy, the parent frame and window.open alone when openLink takes the link", () => {
    launchedBy("android");
    const { openLink } = withSdk();
    const postEvent = webviewProxy();
    const frame = framedBy("https://web.telegram.org", "reported");

    openExternalUrl(TRAMPOLINE);

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith(TRAMPOLINE);
    expect(postEvent, "openLink took the link and it was posted a second time").not.toHaveBeenCalled();
    expect(frame.postMessage).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to the client's channel when openLink throws, instead of ending the tap with nothing", () => {
    launchedBy("tdesktop");
    const { openLink } = withSdk();
    openLink.mockImplementation(() => {
      throw new Error("bridge broken");
    });
    const postEvent = webviewProxy();

    openExternalUrl(TRAMPOLINE);

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(postEvent, "the SDK refused and nothing else was tried").toHaveBeenCalledTimes(1);
    expect(postEvent).toHaveBeenCalledWith("web_app_open_link", JSON.stringify({ url: TRAMPOLINE }));
    expect(open).not.toHaveBeenCalled();
  });

  it("still resolves a t.me link through openTelegramLink, never through the proxy", () => {
    launchedBy("ios");
    const { openTelegramLink, openLink } = withSdk();
    const postEvent = webviewProxy();

    openExternalUrl(CRYPTO_BOT);

    expect(openTelegramLink).toHaveBeenCalledWith(CRYPTO_BOT);
    expect(openLink).not.toHaveBeenCalled();
    expect(postEvent).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["tdesktop", "android", "ios"])(
    "does not post an app scheme the SDK refused, nor retry it through window.open (%s)",
    (platform) => {
      launchedBy(platform);
      // `withSdk` refuses anything that is not http(s), as the real SDK does.
      withSdk();
      const postEvent = webviewProxy();

      openExternalUrl(HAPP);

      expect(postEvent, "an app scheme the SDK refused was posted to the proxy").not.toHaveBeenCalled();
      // Telegram for Android loads such a URL in the Mini App's own web view and
      // replaces the whole Mini App with an error page; with the SDK loaded this
      // tap always ended with nothing opened, and must keep doing so.
      expect(open, "an app scheme the SDK refused was retried through window.open").not.toHaveBeenCalled();
    },
  );
});

describe("outside a Mini App", () => {
  it("opens a new tab and posts to nothing, even where a proxy and a Telegram shell's frame exist", () => {
    // No launch parameters, no SDK, no loader flag: `isTelegramMiniAppSurface()`
    // says browser, so whatever offers a proxy or frames this page is not a
    // Mini App's client and is not handed the link.
    const postEvent = webviewProxy();
    const frame = framedBy("https://web.telegram.org", "reported");

    openExternalUrl(WEB_GATEWAY);

    expect(postEvent).not.toHaveBeenCalled();
    expect(frame.postMessage).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(WEB_GATEWAY, "_blank", "noopener,noreferrer");
  });
});
