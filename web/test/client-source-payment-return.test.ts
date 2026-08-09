// @vitest-environment jsdom

/**
 * The checkout must say `tma` for a Mini App buyer on a network that cannot
 * reach telegram.org.
 *
 * `getClientSource()` is sent as `source` in every checkout body
 * (`api-client/payments.ts`, `api-client/content.ts`). Server-side,
 * `resolvePurchaseContext` gives that client hint TOP precedence, and its own
 * `detected` fallback is structurally always `"web"` because nothing
 * client-side sends the `x-telegram-init-data` header. So this one function
 * decides `buildPaymentReturnUrl`.
 *
 * It read `window.Telegram?.WebApp?.initData` — the bridge, which exists only
 * after ~100 KB has been fetched from telegram.org. This product sells VPN, so
 * the customer at the checkout is on precisely the network that blocks that
 * host: every one of those buyers was classified `"web"`, and the gateway
 * returned them to `${REIWA_DOMAIN}/payment-return` instead of the `t.me` deep
 * link. They paid INSIDE the Mini App and were dropped on the website in an
 * external browser — a different origin, no session, no sign of the purchase
 * they had just made.
 *
 * So `window.Telegram` is defined nowhere below. Anything answering `tma` here
 * was decided from the launch alone. The last case holds the other end: a plain
 * document must still answer `web`, or the fix is "always tma" and the redirect
 * is just as wrong in the other direction.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getClientSource } from "@/lib/client-source";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

const INIT_DATA = `user=%7B%22id%22%3A42%7D&auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`;
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

beforeEach(() => {
  window.history.replaceState({}, "", "/purchase");
  window.location.hash = "";
  window.sessionStorage.clear();
  // The module-level capture survives client-side navigation by design and
  // therefore leaks across spec files.
  __resetTelegramLaunchCaptureForTests();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
});

afterEach(() => {
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
});

describe("the checkout's client-source hint, with no Telegram SDK", () => {
  it("reports `tma` for a launch carrying tgWebAppData in the URL", () => {
    window.location.hash = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.6`;

    expect(
      getClientSource(),
      "a Mini App buyer was classified as web — the gateway will return them to the website in an external browser where they are not signed in, instead of back into the Telegram chat they paid from",
    ).toBe("tma");
    expect(window.Telegram, "the bridge was defined; this case proves nothing").toBeUndefined();
  });

  it("reports `tma` from the session mirror once the hash is gone", () => {
    // The realistic shape: `/purchase` is several react-router navigations away
    // from the launch document, and each one drops the fragment. The mirror the
    // entry chunk wrote is all that is left by checkout time.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppVersion: "9.6" }),
    );
    expect(window.location.hash).toBe("");

    expect(getClientSource()).toBe("tma");
  });

  it("still falls back to the bridge for a launch the URL never carried", () => {
    // An embedder that hands the payload straight to `window.Telegram`. The
    // fallback stays; it is only no longer the source.
    Object.defineProperty(window, "Telegram", {
      value: { WebApp: { initData: INIT_DATA } },
      configurable: true,
      writable: true,
    });

    expect(getClientSource()).toBe("tma");
  });

  it("reports `web` for a plain browser with no launch parameters", () => {
    expect(
      getClientSource(),
      "a plain browser checkout was classified as a Mini App — the gateway would send this buyer to a t.me deep link they cannot follow",
    ).toBe("web");
  });
});
