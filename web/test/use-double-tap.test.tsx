// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { composeGestures, useDoubleTap } from "../src/hooks/use-double-tap";
import { useLongPress } from "../src/hooks/use-long-press";

/**
 * The double-tap gesture, and the fact that it shares one element with two
 * others.
 *
 * WHY THIS FILE EXISTS. The hook shipped with no test at all, and a mutation
 * sweep confirmed what that meant: the tap window could be widened from 300 ms
 * to five seconds, the guard that ignores presses on buttons could be deleted,
 * the move cancel could be deleted, the unmount cleanup could be deleted, and
 * `composeGestures` could be reduced to the exact one-hook-wins bug it was
 * written to prevent — and the entire cabinet suite stayed green for all five.
 *
 * Its own docblock names three things it must not break. Each is a case here.
 */

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(node);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** jsdom has no PointerEvent; MouseEvent carries every field the hook reads. */
function pointer(type: string, x: number, y: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

const fire = (target: Element, type: string, x = 10, y = 10): void => {
  act(() => {
    target.dispatchEvent(pointer(type, x, y));
  });
};

/**
 * The leave a touch screen fires when the finger lifts.
 *
 * Dispatched as `pointerout` with no `relatedTarget`, because that is what
 * React listens to: `onPointerLeave` is SYNTHESISED by its enter/leave plugin
 * from `pointerout`/`pointerover`. A bare `pointerleave` event reaches no React
 * handler at all — the first version of this case dispatched one and passed
 * against the very defect it was written for.
 */
const leave = (target: Element, x = 10, y = 10): void => {
  act(() => {
    const event = pointer("pointerout", x, y) as MouseEvent;
    Object.defineProperty(event, "relatedTarget", { value: null });
    target.dispatchEvent(event);
  });
};

/** One tap: down and up at the same place. */
const tap = (target: Element, x = 10, y = 10): void => {
  fire(target, "pointerdown", x, y);
  fire(target, "pointerup", x, y);
};

function Harness({
  onDoubleTap,
  onLongPress,
}: {
  readonly onDoubleTap: () => void;
  readonly onLongPress?: () => void;
}) {
  const doubleTap = useDoubleTap(onDoubleTap);
  const longPress = useLongPress(onLongPress ?? (() => undefined));
  return (
    <div data-testid="card" {...composeGestures(longPress, doubleTap)}>
      <button type="button" data-testid="action">
        Connect
      </button>
    </div>
  );
}

const card = () => container.querySelector('[data-testid="card"]') as Element;
const action = () => container.querySelector('[data-testid="action"]') as Element;

describe("useDoubleTap", () => {
  it("fires on two quick taps in the same place", () => {
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    tap(card());
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it("does not fire on a single tap", () => {
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not fire when the second tap is too late", () => {
    vi.useFakeTimers();
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    act(() => {
      vi.advanceTimersByTime(400);
    });
    tap(card());
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not fire when the second tap is somewhere else", () => {
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card(), 10, 10);
    tap(card(), 200, 10);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not fire when a swipe follows a tap", () => {
    // The carousel case. A flick starting inside the window used to count as
    // the second tap, and the sheet opened mid-swipe under a moving finger.
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    fire(card(), "pointerdown", 10, 10);
    fire(card(), "pointermove", 120, 12);
    fire(card(), "pointerup", 180, 12);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not fire while a press is still being held", () => {
    // The delete case. Firing on contact opened the sheet AND left the
    // long-press timer running, so the delete dialog landed on top of it.
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    fire(card(), "pointerdown", 10, 10);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("lets the long press still happen, and alone", () => {
    vi.useFakeTimers();
    const onDoubleTap = vi.fn();
    const onLongPress = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} onLongPress={onLongPress} />);
    tap(card());
    fire(card(), "pointerdown", 10, 10);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("ignores taps that begin on a control", () => {
    // The buttons live inside this element, so their presses arrive here too.
    // Opening the globe on top of whatever the button just did is not what a
    // customer double-tapping "Connect" asked for.
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(action());
    tap(action());
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not pair a tap from before a swipe with one after it", () => {
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    fire(card(), "pointerdown", 10, 10);
    fire(card(), "pointermove", 150, 10);
    fire(card(), "pointerup", 150, 10);
    tap(card());
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("survives the pointerleave a touch screen fires after every tap", () => {
    // THE DEFECT THIS FILE MISSED, and the one an operator reported: on touch
    // the pointer is destroyed when the finger lifts, so the browser fires
    // `pointerup` and then immediately `pointerout`/`pointerleave` — on EVERY
    // tap, without the finger going anywhere. A full reset there wiped the
    // first tap a millisecond after it landed and no pair could ever form.
    //
    // With a mouse `pointerleave` fires only when the cursor really leaves, so
    // this worked on a desktop and did nothing whatsoever on a phone. Every
    // case above passed throughout, because none of them fired the event.
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    leave(card());
    tap(card());
    leave(card());
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it("still drops a press the browser takes away mid-gesture", () => {
    // The other half: `pointercancel` and `pointerleave` must abandon the press
    // IN PROGRESS, or a finger that slid off the card and lifted elsewhere
    // would still count as a tap.
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    fire(card(), "pointerdown", 10, 10);
    fire(card(), "pointercancel", 10, 10);
    fire(card(), "pointerup", 10, 10);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not count a drag that returned to its start as a tap", () => {
    // The case ONLY the travelled flag can catch, and the order matters. The
    // drag comes FIRST, so nothing else can explain the result: it starts and
    // ends at the same point, so checking travel at release alone calls it a
    // tap, and the clean tap after it would then pair with it and open the
    // sheet. A press that has travelled has to stay disqualified for the rest
    // of its life, however it ends.
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    fire(card(), "pointerdown", 10, 10);
    fire(card(), "pointermove", 140, 10);
    fire(card(), "pointerup", 10, 10);
    tap(card(), 10, 10);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not fire when the second press wandered and came back", () => {
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card(), 10, 10);
    fire(card(), "pointerdown", 10, 10);
    fire(card(), "pointermove", 140, 10);
    fire(card(), "pointerup", 10, 10);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("stops a pending tap's timer when the element goes away", () => {
    // Asserting "does not throw" is not enough: a leaked timer does not throw
    // in a harness that has nothing left to touch. What must be true is that
    // the timer was actually cancelled.
    vi.useFakeTimers();
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    const before = cleared.mock.calls.length;
    act(() => root.unmount());
    expect(
      cleared.mock.calls.length,
      "unmounting with a tap pending cancelled no timer",
    ).toBeGreaterThan(before);
    cleared.mockRestore();
    render(<Harness onDoubleTap={onDoubleTap} />);
  });

  it("clears its pending tap when the element goes away", () => {
    // The card is unmounted by a swipe, a deletion or a route change, any of
    // which can land between two taps. A timer left running fires against a
    // torn-down tree.
    vi.useFakeTimers();
    const onDoubleTap = vi.fn();
    render(<Harness onDoubleTap={onDoubleTap} />);
    tap(card());
    act(() => root.unmount());
    expect(() => {
      act(() => {
        vi.runAllTimers();
      });
    }).not.toThrow();
    // Re-mount so `afterEach` has something to unmount.
    render(<Harness onDoubleTap={onDoubleTap} />);
  });
});

describe("composeGestures", () => {
  it("runs every hook's handler for a shared event name", () => {
    // The defect it exists to prevent: spreading two hooks onto one node keeps
    // only the last one's handlers, and the element still responds — to one
    // gesture — so nothing looks wrong.
    const calls: string[] = [];
    const merged = composeGestures(
      { onPointerDown: () => calls.push("first") },
      { onPointerDown: () => calls.push("second") },
    );
    merged.onPointerDown?.({} as never);
    expect(calls).toEqual(["first", "second"]);
  });

  it("keeps a handler only one hook supplies", () => {
    const merged = composeGestures(
      { onPointerDown: () => undefined, onClickCapture: () => undefined },
      { onPointerDown: () => undefined },
    );
    expect(typeof merged.onClickCapture).toBe("function");
  });

  it("preserves call order across three sets", () => {
    const calls: number[] = [];
    const merged = composeGestures(
      { onPointerUp: () => calls.push(1) },
      { onPointerUp: () => calls.push(2) },
      { onPointerUp: () => calls.push(3) },
    );
    merged.onPointerUp?.({} as never);
    expect(calls).toEqual([1, 2, 3]);
  });
});
