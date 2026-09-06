import { useCallback, useEffect, useRef } from "react";

/**
 * useDoubleTap
 * ────────────
 * Two quick taps on the same spot. Fires `onDoubleTap` when a second press
 * lands within `window` ms of the first and within `moveTolerance` px of it.
 *
 * Used for "double-tap a subscription card to see its servers".
 *
 * THREE THINGS IT HAS TO NOT BREAK, all of which share this element:
 *
 *  - **The carousel swipe.** Nothing here calls `preventDefault` on a pointer
 *    event and nothing sets `touch-action`, so a horizontal drag reaches the
 *    scroll container untouched. A press that moves past the tolerance simply
 *    stops being a candidate tap.
 *  - **The long press that deletes the card.** That gesture needs the finger
 *    held for 500 ms; a tap here is over long before then, and two of them
 *    still are. The two hooks never contend for the same press.
 *
 * IT RESOLVES ON RELEASE, NOT ON CONTACT, and that is the whole of the two
 * points above. Firing from `pointerdown` committed the gesture before anything
 * knew the press was a tap: a flick starting within the window counted as tap
 * two and opened the sheet mid-swipe, and a press-and-hold opened the sheet on
 * contact while the long-press timer armed by that same press went on to put
 * the delete dialog over it. `pointermove` cannot rescue either — it only
 * cancels a press that has not already fired. The media viewer next door has
 * always done it this way, for the same reason.
 *  - **The buttons on the card face.** They live inside this element, so their
 *    presses arrive here too. A double tap on a button would open the globe on
 *    top of whatever the button just did, so presses that start on an
 *    interactive element are ignored outright.
 */
export function useDoubleTap(
  onDoubleTap: () => void,
  options: { window?: number; moveTolerance?: number } = {},
) {
  const { window: tapWindow = 300, moveTolerance = 24 } = options;
  /** The last COMPLETED tap: a press that went down and came up without travel. */
  const first = useRef<{ x: number; y: number; at: number } | null>(null);
  /** The press in progress, and whether it has stopped being a tap. */
  const press = useRef<{ x: number; y: number; travelled: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const forget = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    first.current = null;
    press.current = null;
  }, []);

  // A pending first tap outliving the component would fire its timer against a
  // torn-down tree — the card is unmounted by a swipe, a deletion, or a route
  // change, any of which can land between two taps.
  useEffect(() => forget, [forget]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      // Presses that begin on a control belong to that control.
      if (
        event.target instanceof Element &&
        event.target.closest("a,button,input,select,textarea,[role='button']")
      ) {
        forget();
        return;
      }

      // Only note where the press began. Whether it becomes a tap is decided
      // when the finger lifts.
      press.current = { x: event.clientX, y: event.clientY, travelled: false };
    },
    [forget],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const started = press.current;
      press.current = null;
      // A press that travelled is a swipe or a drag, whatever its duration.
      if (started === null || started.travelled) return;
      if (
        Math.abs(event.clientX - started.x) > moveTolerance ||
        Math.abs(event.clientY - started.y) > moveTolerance
      ) {
        return;
      }

      const now = Date.now();
      const previous = first.current;
      if (
        previous !== null &&
        now - previous.at <= tapWindow &&
        Math.abs(event.clientX - previous.x) <= moveTolerance &&
        Math.abs(event.clientY - previous.y) <= moveTolerance
      ) {
        forget();
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
        onDoubleTap();
        return;
      }

      first.current = { x: event.clientX, y: event.clientY, at: now };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(forget, tapWindow);
    },
    [forget, moveTolerance, onDoubleTap, tapWindow],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const started = press.current;
      if (started === null) return;
      // Marked rather than cleared: the press must stay disqualified for the
      // rest of its life even if the finger wanders back to where it started.
      if (
        Math.abs(event.clientX - started.x) > moveTolerance ||
        Math.abs(event.clientY - started.y) > moveTolerance
      ) {
        started.travelled = true;
        // A swipe also invalidates the tap before it, so releasing at the end
        // of a flick cannot pair with something from before the flick.
        first.current = null;
      }
    },
    [moveTolerance],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: forget,
    onPointerLeave: forget,
  };
}

type GestureHandlers = Partial<
  Record<
    | "onPointerDown"
    | "onPointerMove"
    | "onPointerUp"
    | "onPointerLeave"
    | "onPointerCancel",
    (event: React.PointerEvent) => void
  > &
    Record<"onClickCapture", (event: React.MouseEvent) => void>
>;

/**
 * Runs several gesture hooks off one element.
 *
 * Spreading two hooks' returns onto the same node silently keeps only the last
 * one's handlers, and the loss is invisible: the element still responds, just
 * to one gesture. This calls every handler each hook supplied for an event.
 */
export function composeGestures(...handlers: GestureHandlers[]): GestureHandlers {
  const merged: Record<string, (event: never) => void> = {};
  for (const set of handlers) {
    for (const [name, handler] of Object.entries(set)) {
      if (handler === undefined) continue;
      const existing = merged[name];
      merged[name] =
        existing === undefined
          ? (handler as (event: never) => void)
          : (event: never) => {
              existing(event);
              (handler as (event: never) => void)(event);
            };
    }
  }
  return merged as GestureHandlers;
}
