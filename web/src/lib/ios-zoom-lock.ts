/**
 * ios-zoom-lock
 * ─────────────
 * iOS Safari / WKWebView (and therefore the Telegram Mini App on iPhone)
 * deliberately IGNORE `user-scalable=no` / `maximum-scale` in the viewport
 * meta since iOS 10 (an accessibility decision). That's why the cabinet could
 * still be pinch-zoomed and double-tap-zoomed on iPhone — and once zoomed, the
 * page pans so content reads as "out of bounds", while Android (which honours
 * the meta) behaves.
 *
 * Suppression rests on TWO cooperating layers, neither of which touches the
 * scroll path:
 *
 *   - CSS `touch-action: pan-x pan-y` on html/body/#root (see `index.css`) —
 *     honoured by iOS 13+ WebKit, it disallows pinch-zoom and double-tap zoom
 *     declaratively, before any JS runs.
 *   - `gesturestart` / `gesturechange` / `gestureend` preventDefault below —
 *     Safari's proprietary pinch events, the belt-and-braces for Safari's own
 *     gesture path. These are NOT touch events: cancelling them never blocks
 *     scrolling, so they may stay non-passive at zero cost.
 *
 * This module used to ALSO install non-passive `touchmove` and `touchend`
 * listeners on `document` (multi-touch pinch + double-tap cancellation). Do
 * not bring them back: a non-passive touch listener on the document disables
 * WebKit's fast-path (compositor-thread) scrolling for the entire app — every
 * scroll had to wait on the main thread, which is exactly the entry-screen
 * lag this module now avoids. The zoom gestures they guarded against are
 * already covered by the two layers above.
 *
 * No-op outside the browser. Purely a zoom suppressor; normal scrolling and
 * interactions are unaffected, so it does not regress accessibility within
 * the app (the app is already a fixed, dark, dvh-locked mobile shell).
 */

let installed = false;

export function installIosZoomLock(): void {
  if (installed || typeof document === 'undefined' || typeof window === 'undefined') return;
  installed = true;

  const prevent = (event: Event) => {
    event.preventDefault();
  };

  // Safari pinch-gesture events (iOS + macOS Safari). Non-standard but the
  // canonical way to block pinch-zoom on Apple browsers. Not touch events —
  // cancelling them does not interfere with scrolling.
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('gesturechange', prevent, { passive: false });
  document.addEventListener('gestureend', prevent, { passive: false });
}
