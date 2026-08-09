import { useEffect, useState } from "react";

import { readTelegramLaunchInitData } from "@/lib/telegram-launch-params";

/** Viewport width (px) at/above which the cabinet switches to the desktop shell. */
export const DESKTOP_BREAKPOINT_PX = 1024;

/**
 * Reactive "is this a desktop web viewport?" check.
 *
 * Returns `true` only when BOTH hold:
 *   - the viewport is at least `DESKTOP_BREAKPOINT_PX` wide, AND
 *   - we're NOT inside a Telegram Mini App (TMA always feels like the phone
 *     app, regardless of the desktop Telegram client's window size).
 *
 * SSR-safe: defaults to `false` (mobile shell) until the first client effect.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    // The launch, not the bridge. This effect has an empty dependency array, so
    // it runs exactly once — at the moment `window.Telegram` is LEAST likely to
    // exist, since the SDK is still in flight from telegram.org. That made the
    // check wrong on a healthy network and permanently wrong on the blocked one
    // this product's customers are on, and the failure is the one the doc
    // comment above says must never happen: a desktop sidebar shell inside a
    // Mini App, whenever the Telegram viewport is also ≥1024px (Telegram Web, a
    // wide Telegram Desktop window). `readTelegramLaunchInitData()` answers from
    // the launch URL, the in-memory capture or the session mirror, with no
    // script and no clock.
    const isTma =
      readTelegramLaunchInitData() !== null ||
      Boolean(window.Telegram?.WebApp?.initData);
    if (isTma) {
      setIsDesktop(false);
      return;
    }
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
    const apply = () => setIsDesktop(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

  return isDesktop;
}
