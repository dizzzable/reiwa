import { useEffect, useState } from "react";

/**
 * useInstallPrompt
 * ────────────────
 * Wraps the PWA install affordances across platforms:
 *   - **Android / Chromium**: captures the `beforeinstallprompt` event so the
 *     cabinet can show its own "Install app" button and trigger the native
 *     prompt on demand (`canInstall` + `promptInstall`).
 *   - **iOS Safari**: there is no programmatic prompt, so we only detect the
 *     situation (`isIos`) and the UI shows a "Share → Add to Home Screen"
 *     instruction sheet instead.
 *   - **Already installed** (`isStandalone`): everything is hidden.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

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
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(detectStandalone);

  useEffect(() => {
    const onBeforeInstall = (e: Event): void => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      setDeferred(null);
      setIsStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const isIos = detectIosSafari();

  const promptInstall = async (): Promise<boolean> => {
    if (deferred === null) return false;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    return choice.outcome === "accepted";
  };

  return {
    canInstall: deferred !== null && !isStandalone,
    isStandalone,
    isIos: isIos && !isStandalone,
    promptInstall,
  };
}

function detectStandalone(): boolean {
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
