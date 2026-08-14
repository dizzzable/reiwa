import { useSyncExternalStore } from "react";
import {
  consumeDeferredInstallPrompt,
  hasInstalledThisDocument,
  readDeferredInstallPrompt,
  subscribeToInstallPromptCapture,
} from "@/lib/install-prompt-capture";

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
  const isIos = detectIosSafari();

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
    canInstall: deferred !== null && !isStandalone,
    isStandalone,
    isIos: isIos && !isStandalone,
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

function detectIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIosDevice =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ masquerades as macOS — disambiguate via touch points.
    (/macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  // Exclude in-app browsers (Chrome/Firefox/Edge on iOS) — they can't add to home.
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIosDevice && isSafari;
}
