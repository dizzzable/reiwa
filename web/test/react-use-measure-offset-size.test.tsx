// @vitest-environment jsdom

/**
 * The dependency contract that silk, beams and dither now rest on.
 *
 * They pass `resize={{ offsetSize: true }}` to fiber, which forwards it to
 * react-use-measure, which is what actually decides whether the measurement —
 * and therefore the CSS size fiber writes back onto the canvas — follows the
 * LAYOUT box or the TRANSFORMED one. `reactbits-layout-sized-canvas.test.tsx`
 * pins that the components ask for it and that the option reaches fiber; this
 * file pins the behaviour ITSELF against the installed package, under the
 * geometry that separates the two: a box laid out at half size and painted at
 * full size by a transform.
 *
 * Worth pinning separately because of how it would break: `offsetSize` is an
 * optional field on an options bag. Drop it from a future react-use-measure and
 * nothing throws, nothing warns, no type fails — the option is simply ignored,
 * every measurement quietly returns to the painted box, and a transformed
 * ancestor starts double-scaling the canvas with no other symptom.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useMeasure from "react-use-measure";

/** A 400×300 layout box painted at 800×600 by `scale(2)`. */
const LAYOUT = { width: 400, height: 300 };
const PAINTED = { width: 800, height: 600 };

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let offsetDescriptors: Array<[string, PropertyDescriptor]> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...PAINTED,
    top: 0,
    left: 0,
    right: PAINTED.width,
    bottom: PAINTED.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // jsdom reports 0 for every offset dimension, so the layout box has to be
  // installed by hand — as a prototype getter, because the element under test
  // is created by React and is not reachable before it is measured.
  offsetDescriptors = (["offsetWidth", "offsetHeight"] as const).map(name => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!,
  ]);
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => LAYOUT.width,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => LAYOUT.height,
  });
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const [name, descriptor] of offsetDescriptors) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Measure a div with the options fiber uses, and report what the hook saw.
 *
 * The window `resize` is the trigger rather than the observer callback because
 * fiber configures react-use-measure with `debounce: { scroll: 50, resize: 0 }`
 * and the observer is wired to the SCROLL-debounced handler — so a resize is
 * the one path that measures synchronously.
 */
function measureWith(options: Record<string, unknown>): { width: number; height: number } {
  let seen = { width: -1, height: -1 };
  function Probe() {
    const [ref, bounds] = useMeasure({
      scroll: true,
      debounce: { scroll: 50, resize: 0 },
      ...options,
    });
    seen = { width: bounds.width, height: bounds.height };
    return <div ref={ref} />;
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  return seen;
}

describe("react-use-measure, as installed", () => {
  it("reports the LAYOUT box when offsetSize is set", () => {
    expect(measureWith({ offsetSize: true })).toEqual(LAYOUT);
  });

  it("reports the PAINTED box without it — which is what the components had", () => {
    // The control. Without this the assertion above could pass on a build where
    // both branches returned the same thing, and would then be guarding nothing:
    // it is only evidence because the two measurements genuinely differ here.
    expect(measureWith({})).toEqual(PAINTED);
  });
});
