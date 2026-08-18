import { useSyncExternalStore } from "react";
import {
  consumeDeferredInstallPrompt,
  hasInstalledThisDocument,
  readDeferredInstallPrompt,
  subscribeToInstallPromptCapture,
} from "@/lib/install-prompt-capture";
import { isTelegramMiniAppSurface } from "@/lib/telegram-launch-params";

/**
 * useInstallPrompt
 * ────────────────
 * Wraps the PWA install affordances across platforms:
 *   - **Android / Chromium**: reads the `beforeinstallprompt` event captured at
 *     the entry point so the cabinet can show its own "Install app" button and
 *     trigger the native prompt on demand (`canInstall` + `promptInstall`).
 *   - **iOS Safari**: there is no programmatic prompt, so we only detect the
 *     situation (`isIos`) and the UI shows a "Share → Add to Home Screen"
 *     instruction sheet instead.
 *   - **Telegram Mini App** (`isTelegramWebview`): neither is possible — see
 *     `isIos` below — so the UI must say so rather than offer either.
 *   - **Already installed** (`isStandalone`): everything is hidden.
 *
 * This hook does NOT listen for `beforeinstallprompt` itself, and must not
 * start: the browser fires it once per page load, minutes before this hook's
 * only consumer — the Settings page — is ever mounted. A listener registered
 * here hears nothing, which is exactly why the install button stopped
 * appearing. `web/src/lib/install-prompt-capture.ts` owns the listeners at
 * module scope and holds the event; this hook is a reader of that stash.
 */

export interface InstallPromptState {
  /** Android/Chromium native prompt is available. */
  readonly canInstall: boolean;
  /** Running as an installed PWA (display-mode standalone). */
  readonly isStandalone: boolean;
  /** iOS Safari (not standalone) — needs the manual add-to-home instructions. */
  readonly isIos: boolean;
  /**
   * Inside a Telegram Mini App webview, where installing is impossible: there
   * is no native prompt to fire and no Share → Add to Home Screen menu to point
   * at. The UI shows the only instruction that is true there — open the cabinet
   * in a real browser — instead of one of the other two.
   */
  readonly isTelegramWebview: boolean;
  /** Fire the native install prompt; resolves true when the user accepts. */
  readonly promptInstall: () => Promise<boolean>;
}

export function useInstallPrompt(): InstallPromptState {
  // `useSyncExternalStore` rather than an effect, because BOTH arrival orders
  // are real and only one of them is an event:
  //   - the event fired long before this hook mounted (the common case, and the
  //     defect) — `getSnapshot` reads the stash on the very first render;
  //   - the event arrives while the Settings page sits open (a slow install
  //     heuristic, a manifest that only just became valid) — the subscription
  //     pushes it.
  // It also closes the window an effect leaves open: an event landing between
  // the first render and the effect would be missed by a subscribe-then-read
  // pair, whereas React re-reads the snapshot after subscribing.
  const deferred = useSyncExternalStore(
    subscribeToInstallPromptCapture,
    readDeferredInstallPrompt,
    () => null,
  );
  const installedThisDocument = useSyncExternalStore(
    subscribeToInstallPromptCapture,
    hasInstalledThisDocument,
    () => false,
  );

  // `appinstalled` is what makes this true mid-session: the tab that triggered
  // the install keeps display-mode `browser`, so `isStandalonePwa()` alone would
  // go on offering to install an app that now exists.
  const isStandalone = isStandalonePwa() || installedThisDocument;
  const inTelegram = isTelegramMiniAppSurface();

  const promptInstall = async (): Promise<boolean> => {
    // Taken and cleared in one step, before the await — a prompt cannot be
    // re-shown, and the native dialog is asynchronous, so a second tap must not
    // find the same event still sitting there. See `consumeDeferredInstallPrompt`.
    const event = consumeDeferredInstallPrompt();
    if (event === null) return false;
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome === "accepted";
  };

  return {
    // Deliberately NOT gated on `inTelegram`, unlike `isIos` below, and the
    // asymmetry is the point. A captured `BeforeInstallPromptEvent` is EVIDENCE
    // — a browser that has decided this document is installable and has handed
    // us the means to say so — whereas `isIos` is an INFERENCE drawn from a
    // string the host app controls. No Telegram client can produce that event
    // today (`beforeinstallprompt` is Chromium browser-layer machinery that
    // neither WKWebView nor Android's WebView carries), so the distinction costs
    // nothing now; if one ever does, the fact outranks our inference and firing
    // the native prompt is exactly the right response.
    canInstall: deferred !== null && !isStandalone,
    isStandalone,
    // `!inTelegram` is load-bearing, not defensive padding. `detectIosSafari()`
    // answers TRUE inside the Telegram Mini App on iPhone: Telegram for iOS
    // ships its WKWebView with Safari's own user agent and appends no token of
    // its own (TelegramMessenger/Telegram-iOS#736, open since 2022 — contrast
    // Telegram for Android, which does append `Telegram`). So the UA test sees
    // `iphone` plus `safari`, misses `crios|fxios|edgios`, and concludes Safari.
    // The Settings row then instructed the largest single group of this
    // product's users to open a Share → Add to Home Screen menu that their
    // webview does not have. A UA guess must not decide this while an
    // authoritative signal sits one import away.
    isIos: detectIosSafari() && !isStandalone && !inTelegram,
    isTelegramWebview: inTelegram && !isStandalone,
    promptInstall,
  };
}

/** Read-only standalone check for shell telemetry; it never captures PWA events. */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const mediaStandalone = window.matchMedia?.("(display-mode: standalone)").matches === true;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return mediaStandalone || iosStandalone;
}

/**
 * "Is this WebKit on an iOS device, in a context that HAS the Share sheet?"
 *
 * The user agent answers the first half and cannot answer the second, which is
 * why the caller has to pair it with `isTelegramMiniAppSurface()`. An in-app
 * WKWebView is WebKit on an iPhone by every test below; whether it also has
 * Safari's Share menu is a fact about the HOST APP, and a host is free to send
 * Safari's string unchanged. Telegram does exactly that, and recent Facebook
 * builds reportedly do too. There is no token that could be added to the
 * exclusion list to fix that — the string does not contain one — so widening
 * the regex would only pretend the question had been answered.
 */
function detectIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIosDevice =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ masquerades as macOS — disambiguate via touch points.
    (/macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  // Exclude the third-party iOS browsers that DO announce themselves (Chrome,
  // Firefox, Edge) — they are WebKit too, and they cannot add to home either.
  // Only as good as the hosts that choose to be honest; see the header.
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIosDevice && isSafari;
}
