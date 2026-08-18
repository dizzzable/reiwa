// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { openExternalUrl, startCheckoutRedirect } from "../src/lib/utils";
import { __resetTelegramLaunchCaptureForTests } from "../src/lib/telegram-launch-params";

/**
 * The lost-payments bug: the checkout link was built correctly, the buyer
 * pressed "pay", and nothing opened.
 *
 * The cause was opening the gateway in a NEW TAB from an async callback. A new
 * tab is a pop-up, and browsers and in-app webviews only permit one while a
 * user gesture is still on the stack — which it never is by the time an HTTP
 * response comes back. Same-tab navigation carries no such rule, so that is
 * what this does, and these tests pin the distinction.
 *
 * The second lost-payments bug had the same shape one level down: the link
 * *was* handed to Telegram, but through `openLink`, which opens an in-app
 * browser. Two of our gateways return `t.me` links — Telegram Stars returns a
 * `createInvoiceLink` invoice (`https://t.me/$<slug>`), CryptoPay returns
 * `https://t.me/CryptoBot?start=…` — and neither can be paid in a browser.
 * The bridge call is therefore load-bearing, and the tests below pin it.
 */

const TELEGRAM = "Telegram" as const;
const SDK_STATE = "__reiwaTelegramSdkState" as const;
/** Where the Telegram SDK mirrors the launch parameters. */
const LAUNCH_PARAMS_KEY = "__telegram__initParams" as const;

/** A Telegram Stars checkout URL, i.e. what `createInvoiceLink` returns. */
const STARS_INVOICE = "https://t.me/$sTaRs-InVoIcE_1=";
/** A CryptoPay checkout URL — a bot deep link, not an invoice link. */
const CRYPTO_BOT = "https://t.me/CryptoBot?start=IVxyz123";
/** An ordinary web gateway (YooKassa and friends). */
const WEB_GATEWAY = "https://pay.example/abc";

type TelegramSpies = {
  openLink: ReturnType<typeof vi.fn>;
  openTelegramLink: ReturnType<typeof vi.fn>;
  openInvoice: ReturnType<typeof vi.fn>;
};

/**
 * Installs a Telegram WebApp stub and returns its spies.
 *
 * `omit` drops bridge methods, standing in for a client older than the Bot API
 * version that introduced them — `openInvoice` is 6.1+, `openTelegramLink`
 * 6.0+, and a buyer on an older build must still reach a payable page.
 */
function withTelegram(present: boolean, omit: (keyof TelegramSpies)[] = []): TelegramSpies {
  const spies: TelegramSpies = {
    openLink: vi.fn(),
    openTelegramLink: vi.fn(),
    openInvoice: vi.fn(),
  };
  if (present) {
    const webApp: Record<string, unknown> = {};
    for (const name of Object.keys(spies) as (keyof TelegramSpies)[]) {
      if (!omit.includes(name)) webApp[name] = spies[name];
    }
    Object.defineProperty(window, TELEGRAM, {
      value: { WebApp: webApp },
      configurable: true,
      writable: true,
    });
  } else {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, TELEGRAM);
  }
  return spies;
}

/** The loader's marker: set for every Telegram launch, even if the SDK 404s. */
function withSdkState(state: 'loading' | 'ready' | 'error' | undefined): void {
  if (state === undefined) {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, SDK_STATE);
    return;
  }
  Object.defineProperty(window, SDK_STATE, { value: state, configurable: true, writable: true });
}

function stubAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign },
    configurable: true,
    writable: true,
  });
  return assign;
}

afterEach(() => {
  withTelegram(false);
  withSdkState(undefined);
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  vi.restoreAllMocks();
});

describe("checkout redirect", () => {
  it("navigates the current tab outside Telegram", () => {
    withTelegram(false);
    const assign = stubAssign();

    expect(startCheckoutRedirect("https://pay.example/abc")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://pay.example/abc");
  });

  it("never opens a pop-up, which is what the gesture rule blocks", () => {
    withTelegram(false);
    stubAssign();
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    startCheckoutRedirect("https://pay.example/abc");

    expect(open).not.toHaveBeenCalled();
  });

  it("declines inside a Telegram Mini App instead of navigating it away", () => {
    // Steering the Mini App webview to a third-party origin breaks the
    // container with no way back. Reporting `false` is what makes the caller
    // show the manual button.
    withTelegram(true);
    const assign = stubAssign();

    expect(startCheckoutRedirect("https://pay.example/abc")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("still asks Telegram to open the link, which is what works on mobile", () => {
    // Desktop enforces the gesture and declines; mobile clients honour this and
    // the buyer never has to press anything. Skipping the attempt outright
    // would take auto-open away from the majority surface.
    const { openLink } = withTelegram(true);
    stubAssign();

    startCheckoutRedirect(WEB_GATEWAY);

    expect(openLink).toHaveBeenCalledWith(WEB_GATEWAY);
  });

  it("treats a Telegram launch as Telegram even when the SDK never loaded", () => {
    // telegram.org is unreachable from some networks. Without this the Mini App
    // is indistinguishable from a browser and we navigate the container away.
    withTelegram(false);
    withSdkState('error');
    const assign = stubAssign();

    expect(startCheckoutRedirect("https://pay.example/abc")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("treats a Telegram launch as Telegram when only the launch parameters survive", () => {
    // The gap the private `isTelegramLaunch()` left. It asked two questions —
    // is the bridge here, did the loader stamp its flag — and BOTH can be
    // absent on a live Mini App. The bridge needs ~100 KB from telegram.org,
    // the host this product's customers buy a VPN to reach; the loader stamps
    // only on a document where it found the parameters itself, so a reload deep
    // inside the Mini App, or a partitioned iframe whose `sessionStorage` threw
    // while the loader ran, leaves both answers empty.
    //
    // The parameters outlive all of that: `tgWebAppPlatform`/`tgWebAppVersion`
    // describe the CLIENT and are what the payload teardown deliberately leaves
    // behind. `isTelegramMiniAppSurface()` reads them FIRST, so it still says
    // "Mini App" here.
    //
    // On the old detector this fails the loud way, which is the point: `assign`
    // is called and the Mini App container is navigated to the gateway origin,
    // with no way back — the exact outcome the whole function exists to avoid.
    withTelegram(false);
    withSdkState(undefined);
    window.sessionStorage.setItem(
      LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppPlatform: "ios", tgWebAppVersion: "9.6" }),
    );
    const assign = stubAssign();

    expect(startCheckoutRedirect(WEB_GATEWAY)).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("refuses a javascript: url instead of executing it in our origin", () => {
    // `location.assign` is a script sink; the old `window.open` was not. The
    // address arrives in an API response, so it is not ours to trust.
    withTelegram(false);
    const assign = stubAssign();

    expect(startCheckoutRedirect("javascript:alert(document.cookie)")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(["http://pay.example/abc", "data:text/html,x", "/relative", "not a url"])(
    "refuses %s",
    (url) => {
      withTelegram(false);
      const assign = stubAssign();

      expect(startCheckoutRedirect(url)).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it("reports failure for a missing url rather than navigating nowhere", () => {
    withTelegram(false);
    const assign = stubAssign();

    expect(startCheckoutRedirect("")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("checkout redirect: which Telegram bridge opens the link", () => {
  it("raises the native invoice sheet for a Telegram Stars link, not a browser", () => {
    // Telegram Stars is one of two gateways enabled in production and its
    // `checkoutUrl` is a `createInvoiceLink` invoice. `openLink` would show the
    // t.me landing page in the in-app browser, which has no way to pay.
    const { openInvoice, openTelegramLink, openLink } = withTelegram(true);
    stubAssign();

    startCheckoutRedirect(STARS_INVOICE);

    expect(openInvoice).toHaveBeenCalledWith(STARS_INVOICE);
    expect(openTelegramLink).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });

  it("resolves a CryptoPay bot deep link through Telegram, not a browser", () => {
    // CryptoPay's `bot_invoice_url` is a bot deep link, not an invoice link:
    // `openInvoice` would throw `WebAppInvoiceUrlInvalid` on it.
    const { openTelegramLink, openInvoice, openLink } = withTelegram(true);
    stubAssign();

    startCheckoutRedirect(CRYPTO_BOT);

    expect(openTelegramLink).toHaveBeenCalledWith(CRYPTO_BOT);
    expect(openInvoice).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });

  it("keeps sending an ordinary gateway page to the in-app browser", () => {
    // The other two bridges reject a non-`t.me` host outright, so widening the
    // native path to every checkout URL would break the web gateways.
    const { openLink, openTelegramLink, openInvoice } = withTelegram(true);
    stubAssign();

    startCheckoutRedirect(WEB_GATEWAY);

    expect(openLink).toHaveBeenCalledWith(WEB_GATEWAY);
    expect(openTelegramLink).not.toHaveBeenCalled();
    expect(openInvoice).not.toHaveBeenCalled();
  });

  it("falls back to openTelegramLink when the client predates openInvoice", () => {
    // Bot API 6.1 introduced `openInvoice`. On an older client the link still
    // has to reach Telegram — losing the sheet beats losing the payment.
    const { openTelegramLink, openLink } = withTelegram(true, ["openInvoice"]);
    stubAssign();

    startCheckoutRedirect(STARS_INVOICE);

    expect(openTelegramLink).toHaveBeenCalledWith(STARS_INVOICE);
    expect(openLink).not.toHaveBeenCalled();
  });

  it("falls back to openLink when the client has neither native bridge", () => {
    const { openLink } = withTelegram(true, ["openInvoice", "openTelegramLink"]);
    stubAssign();

    startCheckoutRedirect(STARS_INVOICE);

    expect(openLink).toHaveBeenCalledWith(STARS_INVOICE);
  });

  it("falls through when a bridge throws rather than swallowing the payment", () => {
    // The bridge validates and throws (`WebAppInvoiceUrlInvalid`). A throw must
    // not end the attempt — it means "not me", so the next bridge gets a turn.
    const spies = withTelegram(true);
    spies.openInvoice.mockImplementation(() => {
      throw new Error("WebAppInvoiceUrlInvalid");
    });
    stubAssign();

    startCheckoutRedirect(STARS_INVOICE);

    expect(spies.openTelegramLink).toHaveBeenCalledWith(STARS_INVOICE);
  });

  it("never navigates the Mini App away, whichever bridge is used", () => {
    const { openInvoice } = withTelegram(true);
    const assign = stubAssign();

    expect(startCheckoutRedirect(STARS_INVOICE)).toBe(false);
    expect(openInvoice).toHaveBeenCalled();
    // `false` even on success: nothing acknowledges the sheet actually opened,
    // so the manual button on /payment-return stays as the belt to this brace.
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "tg://resolve?domain=CryptoBot"])(
    "hands %s to no bridge at all",
    (url) => {
      // The https-only guard runs first and is a single-value equality test, so
      // a scheme cannot sneak in through the Telegram path either.
      const { openLink, openTelegramLink, openInvoice } = withTelegram(true);
      stubAssign();

      expect(startCheckoutRedirect(url)).toBe(false);
      expect(openLink).not.toHaveBeenCalled();
      expect(openTelegramLink).not.toHaveBeenCalled();
      expect(openInvoice).not.toHaveBeenCalled();
    },
  );
});

describe("checkout redirect: a t.me link in a plain browser", () => {
  it.each([STARS_INVOICE, CRYPTO_BOT])(
    "declines %s instead of replacing the cabinet tab",
    (url) => {
      // A t.me link is not a checkout page: no `return_url`, so it never sends
      // the buyer back to /payment-return, and on desktop it is only an "Open
      // in Telegram" interstitial. Assigning it destroys the polling tab for a
      // page that cannot complete the purchase and cannot navigate back.
      withTelegram(false);
      const assign = stubAssign();

      expect(startCheckoutRedirect(url)).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it("does not reach for a pop-up either — that is the original bug", () => {
    // Declining must not turn into `window.open` from an async callback. The
    // gesture comes from the buyer pressing "Open payment" on /payment-return.
    withTelegram(false);
    stubAssign();
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    startCheckoutRedirect(STARS_INVOICE);

    expect(open).not.toHaveBeenCalled();
  });

  it("still assigns an ordinary gateway page, which does redirect back", () => {
    withTelegram(false);
    const assign = stubAssign();

    expect(startCheckoutRedirect(WEB_GATEWAY)).toBe(true);
    expect(assign).toHaveBeenCalledWith(WEB_GATEWAY);
  });

  it("is not fooled by a host that merely starts with t.me", () => {
    withTelegram(false);
    const assign = stubAssign();

    expect(startCheckoutRedirect("https://t.me.evil.example/$slug")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://t.me.evil.example/$slug");
  });
});

describe("openExternalUrl shares the one bridge rule", () => {
  // The manual "Open payment" button goes through this function. Two copies of
  // the rule is what let checkout drift into `openLink`; these pin them equal.

  it("raises the invoice sheet for a Stars link from a real click", () => {
    const { openInvoice, openLink } = withTelegram(true);

    openExternalUrl(STARS_INVOICE);

    expect(openInvoice).toHaveBeenCalledWith(STARS_INVOICE);
    expect(openLink).not.toHaveBeenCalled();
  });

  it("keeps resolving tg: deep links natively for the Connect action", () => {
    const { openTelegramLink, openLink } = withTelegram(true);

    openExternalUrl("tg://resolve?domain=Bot");

    expect(openTelegramLink).toHaveBeenCalledWith("tg://resolve?domain=Bot");
    expect(openLink).not.toHaveBeenCalled();
  });

  it("opens a new tab outside Telegram, where the click gesture is live", () => {
    withTelegram(false);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    openExternalUrl(STARS_INVOICE);

    expect(open).toHaveBeenCalledWith(STARS_INVOICE, "_blank", "noopener,noreferrer");
  });
});
