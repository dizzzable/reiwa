import { useCallback, useRef } from "react";

/**
 * useLongPress
 * ────────────
 * Press-and-hold gesture for touch + mouse. Fires `onLongPress` only when the
 * pointer is held past `threshold` ms without moving more than `moveTolerance`
 * px (so scrolling/dragging cancels it). A short press never fires. Returns
 * pointer handlers to spread onto the target element.
 *
 * Used for "long-press a subscription card to delete it" — a destructive
 * action gated afterwards by a confirmation modal.
 */
export function useLongPress(
  onLongPress: () => void,
  options: { threshold?: number; moveTolerance?: number } = {},
) {
  const { threshold = 500, moveTolerance = 10 } = options;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only primary button / touch / pen.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        // Optional haptic when the threshold is reached (Telegram Mini App).
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
        onLongPress();
      }, threshold);
    },
    [onLongPress, threshold],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (start.current === null) return;
      const dx = Math.abs(e.clientX - start.current.x);
      const dy = Math.abs(e.clientY - start.current.y);
      if (dx > moveTolerance || dy > moveTolerance) clear();
    },
    [clear, moveTolerance],
  );

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    // Swallow the click that follows a long-press so it doesn't also trigger
    // the card's normal tap action.
    if (fired.current) {
      e.preventDefault();
      e.stopPropagation();
      fired.current = false;
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onClickCapture,
  };
}
