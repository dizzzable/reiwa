// @vitest-environment jsdom

/**
 * The install affordance must not offer iOS's Share → Add to Home Screen inside
 * the Telegram Mini App, because that menu does not exist there.
 *
 * `useInstallPrompt` decided `isIos` from the user agent alone, excluding the
 * third-party iOS browsers that announce themselves (`crios|fxios|edgios`).
 * Telegram for iOS announces nothing: it ships its WKWebView with Safari's own
 * user agent and appends no token of its own (TelegramMessenger/Telegram-iOS#736,
 * open since 2022 — Telegram for ANDROID does append `Telegram`, which is part
 * of why the gap was easy to miss). So the UA test saw `iphone` plus `safari`,
 * missed the exclusions, and concluded Safari. The Settings row appeared for
 * every iPhone user inside the Mini App and told them to open a Share menu
 * their webview does not have — defeating the button for the largest single
 * group of this product's users.
 *
 * Every case below therefore uses ONE user agent — a genuine iPhone Safari
 * string, the one the old code was right about — and changes only whether
 * Telegram launched the document. If a verdict still tracks the UA, the gate is
 * not there.
 *
 * The launch is established WITHOUT `window.Telegram` in the first four cases,
 * for the reason `surface-telemetry-tma.test.tsx` states at length: the bridge
 * exists only after ~100 KB has been fetched from telegram.org, and this
 * product sells VPN, so that host is precisely the one its customers cannot
 * reach. A gate that needs the bridge is a gate that stands open exactly where
 * the Mini App population is largest.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInstallPrompt, type InstallPromptState } from "@/hooks/use-install-prompt";
import {
  __resetInstallPromptCaptureForTests,
  captureInstallPromptEvents,
} from "@/lib/install-prompt-capture";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

/**
 * Safari on an iPhone, verbatim — and, per the header, byte-for-byte what
 * Telegram's own webview sends. That identity IS the defect; stating it once
 * here is what makes the Telegram cases meaningful rather than a second, quietly
 * different string doing the work.
 */
const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** A live launch payload — `auth_date` now, not 1970, so it is not spent. */
const LAUNCH_AUTH_DATE = Math.floor(Date.now() / 1000);
const INIT_DATA = "user=%7B%22id%22%3A42%7D&auth_date=" + LAUNCH_AUTH_DATE + "&hash=deadbeef";
const LAUNCH_HASH = "#tgWebAppData=" + encodeURIComponent(INIT_DATA) + "&tgWebAppVersion=9.6";
/** The SDK's own session key; the cabinet mirrors the launch into it. */
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** The live hook result, refreshed on every render of the probe. */
let state: InstallPromptState | null = null;

function Probe(): ReactNode {
  state = useInstallPrompt();
  return null;
}

function mountProbe(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Probe />);
  });
}

/** Chromium's install event, as `install-prompt-capture.test.tsx` builds it. */
function makeInstallPromptEvent(): Event {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, {
    prompt: () => Promise.resolve(),
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  return event;
}

function forget(name: string): void {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, name);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetInstallPromptCaptureForTests();
  __resetTelegramLaunchCaptureForTests();
  state = null;

  // One user agent for the whole file. jsdom defines `userAgent` on
  // `Navigator.prototype`, so an own accessor on the instance shadows it and
  // `afterEach` can take it back off.
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    get: () => IPHONE_SAFARI_UA,
  });

  // Not an installed PWA. `isStandalone` gates every other field off, so a
  // stray standalone verdict would pass these cases for a reason none of them
  // is about.
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList => ({ matches: false, media: query }) as MediaQueryList,
  );

  window.history.replaceState({}, "", "/settings");
  window.location.hash = "";
  window.sessionStorage.clear();
  forget("Telegram");
  forget("__reiwaTelegramSdkState");
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state = null;
  __resetInstallPromptCaptureForTests();
  __resetTelegramLaunchCaptureForTests();
  window.location.hash = "";
  window.sessionStorage.clear();
  Reflect.deleteProperty(window.navigator, "userAgent");
  forget("Telegram");
  forget("__reiwaTelegramSdkState");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("one iPhone Safari user agent, inside and outside Telegram", () => {
  it("still offers the Share sheet in real Safari", () => {
    // The other end of the gate. Without this case, "never claim iOS" would
    // satisfy everything below while removing the feature from the users it was
    // built for.
    mountProbe();

    expect(
      state?.isIos,
      "iPhone Safari lost its add-to-home instructions — the gate is not a Telegram gate, it is an iOS kill switch",
    ).toBe(true);
    expect(state?.isTelegramWebview).toBe(false);
  });

  it("does not claim iOS Safari for a Mini App launched by URL", () => {
    window.location.hash = LAUNCH_HASH;

    mountProbe();

    expect(
      state?.isIos,
      "the install row still tells a Telegram Mini App user to open Safari's Share menu, which their webview does not have — this is the defect, and no user agent can see it",
    ).toBe(false);
    expect(
      state?.isTelegramWebview,
      "nothing is offered in its place, so the row simply vanishes and a subscriber who wants the app is told nothing at all",
    ).toBe(true);
  });

  it("does not claim iOS Safari on a later document that has only the session mirror", () => {
    // A reload, the return leg from a payment gateway, an OS-restored webview:
    // the URL has lost the fragment and `sessionStorage` is all that is left.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppPlatform: "ios" }),
    );

    mountProbe();

    expect(
      state?.isIos,
      "a Mini App that reloaded went back to being treated as Safari — the gate only reads this document's own URL",
    ).toBe(false);
    expect(state?.isTelegramWebview).toBe(true);
  });

  it("does not claim iOS Safari after the launch payload has been forgotten", () => {
    // Exactly what `forgetTelegramLaunchPayload()` leaves behind when the server
    // has refused the payload with a 401, and what `isSpentLaunchPayload` leaves
    // once the server's own 24h window has closed: the CLIENT description,
    // never `tgWebAppData`.
    //
    // This case is what separates the SURFACE question from the AUTH one. Gate
    // on `readTelegramLaunchInitData()` — the payload — and it goes red: a live
    // Mini App is relabelled a browser precisely on the sessions that have
    // already had one thing go wrong.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppPlatform: "ios", tgWebAppVersion: "9.6" }),
    );

    mountProbe();

    expect(
      state?.isIos,
      "a Mini App whose payload was spent or refused is treated as Safari — the surface was decided by a value the auth flow deliberately destroys",
    ).toBe(false);
    expect(state?.isTelegramWebview).toBe(true);
  });

  it("does not claim iOS Safari when only the loader's flag survives", () => {
    // The tail neither the URL nor the mirror covers: Telegram Web runs the Mini
    // App in an iframe, and in a partitioned context `sessionStorage` throws on
    // access, so no mirror was ever written. The loader stamps this flag before
    // it requests the SDK and leaves it set when the request fails.
    (window as unknown as Record<string, unknown>).__reiwaTelegramSdkState = "error";

    mountProbe();

    expect(state?.isIos, "the only surviving signal of a Telegram launch was ignored").toBe(false);
    expect(state?.isTelegramWebview).toBe(true);
  });
});

describe("what the Telegram gate must not take away", () => {
  it("still fires the native prompt when a browser actually offered one", () => {
    // A captured `BeforeInstallPromptEvent` is a browser's own verdict that this
    // document is installable; `isIos` is an inference from a string the host
    // app controls. If a Telegram client ever hands us that event, the fact
    // outranks the inference — gating `canInstall` on the surface as well would
    // throw away a working install for a hypothetical.
    window.location.hash = LAUNCH_HASH;
    captureInstallPromptEvents();
    window.dispatchEvent(makeInstallPromptEvent());

    mountProbe();

    expect(
      state?.canInstall,
      "a real, captured install prompt was suppressed because the document happens to be a Mini App",
    ).toBe(true);
  });

  it("offers nothing once the app is installed", () => {
    window.location.hash = LAUNCH_HASH;
    vi.stubGlobal(
      "matchMedia",
      (query: string): MediaQueryList => ({ matches: true, media: query }) as MediaQueryList,
    );

    mountProbe();

    expect(state?.isStandalone).toBe(true);
    expect(
      state?.isTelegramWebview,
      "an installed PWA is still being told how to install itself",
    ).toBe(false);
    expect(state?.isIos).toBe(false);
  });
});
