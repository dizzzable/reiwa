import { useEffect, useState } from "react";

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
    const isTma = Boolean(window.Telegram?.WebApp?.initData);
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
