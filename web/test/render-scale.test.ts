/**
 * The device-pixel budget every effect's drawing buffer is sized through.
 *
 * Two properties carry the whole design and both are asserted from the
 * arithmetic rather than from a remembered constant:
 *   1. below the budget the answer is EXACTLY 1 — cards, panel previews and
 *      phones must come out bit-identical to what they render today, or the
 *      cap has quietly become a redesign of the artwork;
 *   2. above it, the resulting buffer is inside the budget — asserted by
 *      recomputing `css × css × ratio²` from the returned scale, so a wrong
 *      formula fails here even if the returned number looks plausible.
 */

import { describe, expect, it } from "vitest";

import {
  RENDER_PIXEL_BUDGET,
  RENDER_SCALE_STEPS,
  resolveBufferRatio,
  resolveRenderScale,
} from "../src/components/reactbits/render-scale";

/** Device pixels a `css × css` box actually allocates at `ratio × scale`. */
const bufferPixels = (
  cssWidth: number,
  cssHeight: number,
  deviceRatio: number,
): number => {
  const ratio = resolveBufferRatio(cssWidth, cssHeight, deviceRatio);
  return cssWidth * cssHeight * ratio * ratio;
};

describe("resolveRenderScale — mounts that must not change at all", () => {
  it.each([
    ["subscription card, ogl default ratio", 343, 201, 1],
    ["subscription card at DPR 2", 343, 201, 2],
    ["panel picker tile", 208, 117, 2],
    ["iPhone 393×852, ratio clamped to 2", 393, 852, 2],
    ["largest phone 440×956, ratio clamped to 2", 440, 956, 2],
    ["1512×982 laptop at ogl default ratio", 1512, 982, 1],
  ])("%s is left at exactly 1", (_name, width, height, ratio) => {
    // Not `toBeCloseTo`. A scale of 0.975 would still "look right" and would
    // silently resample every card in the product.
    expect(resolveRenderScale(width, height, ratio)).toBe(1);
    expect(resolveBufferRatio(width, height, ratio)).toBe(ratio);
  });

  it("leaves the largest phone alone with real headroom, not by a hair", () => {
    // The deleted governor's 1.5M budget put this device at 1.68M — just over —
    // and quantised it to 0.9, degrading the one device the whole exercise was
    // supposed to protect. Stated as the margin, because the margin is the
    // point: a slightly bigger phone must still land on 1.
    expect(440 * 956 * 2 * 2).toBeLessThan(RENDER_PIXEL_BUDGET);
    expect(RENDER_PIXEL_BUDGET / (440 * 956 * 2 * 2)).toBeGreaterThan(1.2);
  });
});

describe("resolveRenderScale — mounts that must come down", () => {
  it.each([
    ["1440p desktop, ogl default ratio", 2560, 1440, 1],
    ["1440p desktop at DPR 2", 2560, 1440, 2],
    ["1512×982 laptop at DPR 2", 1512, 982, 2],
    ["4K desktop at DPR 2", 3840, 2160, 2],
    ["iPad Pro portrait at DPR 2", 1024, 1366, 2],
    ["iPhone 393×852 at native DPR 3", 393, 852, 3],
  ])("%s ends up inside the budget", (_name, width, height, ratio) => {
    expect(resolveRenderScale(width, height, ratio)).toBeLessThan(1);
    expect(bufferPixels(width, height, ratio)).toBeLessThanOrEqual(
      RENDER_PIXEL_BUDGET,
    );
    // …and is not thrown away: a formula that returned some tiny constant
    // would satisfy the line above and blur every desktop to mush.
    expect(bufferPixels(width, height, ratio)).toBeGreaterThan(
      RENDER_PIXEL_BUDGET * 0.9,
    );
  });

  it("caps the BUFFER, so the same viewport costs the same at either ratio", () => {
    // 2560×1440 allocates 3.7M at ogl's default ratio and 14.7M at DPR 2. The
    // budget is denominated in buffer pixels, so both must land on one number —
    // this is what makes the cap independent of each family's DPR convention.
    expect(bufferPixels(2560, 1440, 1)).toBe(bufferPixels(2560, 1440, 2));
    expect(resolveBufferRatio(2560, 1440, 1)).toBe(
      resolveBufferRatio(2560, 1440, 2),
    );
  });

  it("shrinks monotonically as the box grows", () => {
    let previous = resolveRenderScale(1920, 1080, 2);
    for (const width of [2048, 2560, 3072, 3440, 3840, 5120]) {
      const next = resolveRenderScale(width, 1440, 2);
      expect(next).toBeLessThanOrEqual(previous);
      previous = next;
    }
  });
});

describe("resolveRenderScale — quantisation", () => {
  it("returns whole fortieths", () => {
    for (const width of [2000, 2400, 2560, 3000, 3440, 3840]) {
      const scale = resolveRenderScale(width, 1440, 2);
      expect(Number.isInteger(scale * RENDER_SCALE_STEPS)).toBe(true);
    }
  });

  it("puts its step boundaries far enough apart that a resize storm cannot churn", () => {
    // The property that makes the step load-bearing: an iOS address-bar gesture
    // emits a resize per frame, and a scale that tracked them continuously would
    // reallocate the drawing buffer sixty times a second.
    //
    // NOT "a 1-px resize never changes the scale" — that is false, and a test
    // asserting it would have to be weakened until it proved nothing. A 1-px
    // resize crosses a boundary at the one width in ~170 where a boundary sits.
    // What is true, and what is asserted, is that each crossing moves exactly
    // one step and the crossings are far apart.
    const boundaries: number[] = [];
    let previous = resolveRenderScale(1600, 1440, 2);
    for (let width = 1601; width <= 4000; width += 1) {
      const current = resolveRenderScale(width, 1440, 2);
      if (current !== previous) {
        expect(
          Math.round((previous - current) * RENDER_SCALE_STEPS),
          `scale jumped more than one step at ${width}px`,
        ).toBe(1);
        boundaries.push(width);
        previous = current;
      }
    }
    // A sweep that found no boundaries at all would satisfy every line above
    // while measuring nothing.
    expect(boundaries.length).toBeGreaterThan(5);
    const gaps = boundaries
      .slice(1)
      .map((width, index) => width - boundaries[index]);
    expect(Math.min(...gaps)).toBeGreaterThan(100);
  });

  it("never rounds up over the budget", () => {
    // Rounding to nearest instead of down is the one mutation that leaves every
    // other case in this file green. Swept because it only shows up at the
    // sizes where the exact scale sits just above a step boundary.
    //
    // The tolerance is double-precision slack in `steps / 40`, not slack in the
    // rule: a fortieth that is not binary-representable is correctly rounded and
    // can land a few parts in 10^16 high, which showed up as 2073600.0000000007
    // for one width in this sweep. 1e-9 is a billion times larger than that and
    // still a millionth of one quantisation step, so rounding to nearest —
    // which overshoots by up to 2.5% of the budget — cannot hide inside it.
    for (let width = 1000; width <= 6000; width += 7) {
      for (const ratio of [1, 2, 3]) {
        expect(bufferPixels(width, 1440, ratio)).toBeLessThanOrEqual(
          RENDER_PIXEL_BUDGET * (1 + 1e-9),
        );
      }
    }
  });
});

describe("resolveRenderScale — input it cannot reason about", () => {
  it.each([
    ["jsdom / pre-layout zero box", 0, 0, 2],
    ["a negative width", -100, 500, 2],
    ["NaN width", Number.NaN, 800, 2],
    ["NaN height", 800, Number.NaN, 2],
    ["a browser reporting no ratio", 2560, 1440, Number.NaN],
    ["a zero ratio", 2560, 1440, 0],
    ["an infinite box", Number.POSITIVE_INFINITY, 1440, 2],
  ])("%s leaves the buffer alone", (_name, width, height, ratio) => {
    expect(resolveRenderScale(width, height, ratio)).toBe(1);
  });

  it("never returns zero, so a canvas can never be sized away", () => {
    const absurd = resolveRenderScale(200_000, 200_000, 4);
    expect(absurd).toBeGreaterThan(0);
    expect(absurd).toBe(1 / RENDER_SCALE_STEPS);
  });
});
