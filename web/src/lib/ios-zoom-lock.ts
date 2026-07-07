/**
 * ios-zoom-lock
 * ─────────────
 * iOS Safari / WKWebView (and therefore the Telegram Mini App on iPhone)
 * deliberately IGNORE `user-scalable=no` / `maximum-scale` in the viewport
 * meta since iOS 10 (an accessibility decision). That's why the cabinet could
 * still be pinch-zoomed and double-tap-zoomed on iPhone — and once zoomed, the
 * page pans so content reads as "out of bounds", while Android (which honours
 * the meta) behaves. The only reliable way to suppress it is to cancel the
 * relevant touch/gesture events in JS:
 *
 *   - `gesturestart` / `gesturechange` / `gestureend` — Safari-only pinch
 *     gesture events. Cancelling `gesturestart` stops pinch-zoom.
 *   - multi-touch `touchmove` (2+ fingers) — belt-and-suspenders for engines
 *     that don't fire the gesture events.
 *   - double-tap zoom — cancel the second `touchend` inside ~300ms.
 *
 * Listeners are non-passive (`{ passive: false }`) so `preventDefault()` is
 * honoured. We intentionally do NOT touch single-finger scrolling, taps, or
 * the carousel swipe — only the zoom gestures. No-op outside the browser.
 *
 * This is purely a zoom suppressor; normal scrolling and interactions are
 * unaffected, so it does not regress accessibility within the app (the app is
 * already a fixed, dark, dvh-locked mobile shell).
 */

let installed = false;

export function installIosZoomLock(): void {
  if (installed || typeof document === 'undefined' || typeof window === 'undefined') return;
  installed = true;

  const prevent = (event: Event) => {
    event.preventDefault();
  };

  // Safari pinch-gesture events (iOS + macOS Safari). Non-standard but the
  // canonical way to block pinch-zoom on Apple browsers.
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('gesturechange', prevent, { passive: false });
  document.addEventListener('gestureend', prevent, { passive: false });

  // Pinch via raw touches (engines that don't emit gesture* events): a
  // touchmove with more than one active touch is a zoom/scale attempt.
  document.addEventListener(
    'touchmove',
    (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );

  // Double-tap-to-zoom: cancel the SECOND tap when it lands within 300ms.
  // Critically, only genuine STATIONARY taps count — a swipe (finger moved
  // more than a few px) must never be treated as a tap, otherwise the second
  // `touchend` of two quick carousel/page swipes would be preventDefault()ed
  // and could interrupt the fling/scroll-snap on iOS. So we track the start
  // point and reset the tap chain whenever the finger moved.
  const TAP_MOVE_TOLERANCE_PX = 10;
  let lastTapTime = 0;
  let startX = 0;
  let startY = 0;
  document.addEventListener(
    'touchstart',
    (event: TouchEvent) => {
      if (event.touches.length === 1) {
        startX = event.touches[0]!.clientX;
        startY = event.touches[0]!.clientY;
      }
    },
    { passive: true },
  );
  document.addEventListener(
    'touchend',
    (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      const moved =
        touch === undefined ||
        Math.abs(touch.clientX - startX) > TAP_MOVE_TOLERANCE_PX ||
        Math.abs(touch.clientY - startY) > TAP_MOVE_TOLERANCE_PX;
      if (moved) {
        // A swipe/drag — never a double-tap. Reset the chain and leave the
        // event untouched so momentum scrolling / snap is not disturbed.
        lastTapTime = 0;
        return;
      }
      const now = Date.now();
      if (now - lastTapTime <= 300) event.preventDefault();
      lastTapTime = now;
    },
    { passive: false },
  );
}
