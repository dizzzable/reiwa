/**
 * Device-pixel budget for card effects.
 * ─────────────────────────────────────
 * Every effect in the catalog is mounted twice: as card artwork, where its box
 * is a couple of hundred CSS pixels a side, and — for one of them at a time —
 * as the full-screen app background, where the same component shades the entire
 * viewport every frame. A 343×201 card is ~69k buffer pixels; a 2560×1440
 * desktop at ogl's default ratio is 3.7M, and at DPR 2 it is 14.7M. That is a
 * ×50–×200 fill-rate multiplier nothing in the catalog was designed against,
 * and for the canvas2d family the bill lands on the MAIN THREAD, where it is
 * felt as input latency rather than as dropped shader frames.
 *
 * MDN's sanctioned mitigation for a fill-rate-bound canvas (WebGL best
 * practices, "Small back buffers"): "render into a smaller back buffer and
 * upscale… keep canvas.style width/height constant". The two halves matter
 * equally. Reducing the BACKING STORE lowers sampling density. Keeping the CSS
 * size CONSTANT is what makes it a resolution change rather than a different
 * picture — every effect derives its features (a wave lattice's pitch, a
 * snowflake's radius, how many particles fit) from the box it is given, so
 * shrinking that box magnifies every feature by 1/scale and divides every count
 * by scale². An operator tuning `xGap: 10` in the panel must get a 10 px pitch
 * in the cabinet at every viewport, and that is only true if the CSS box is
 * left alone.
 *
 * So the cap lives HERE — inside each component, at the one line where it turns
 * its CSS box into a drawing buffer — and never in a wrapper above it. A
 * previous round put a `transform: scale()` governor in `AppBackground`
 * instead; it changed the picture, was inert for the 20 effects that measure
 * with `getBoundingClientRect()`, and clipped `prismGrid` outright.
 *
 * Nothing here knows or cares whether it is being asked about a card or a
 * viewport: below the budget the answer is exactly 1, so cards, previews and
 * phones come out bit-identical and only the genuinely oversized mounts move.
 */

/**
 * The ceiling, in device pixels of DRAWING BUFFER, for one effect frame.
 *
 * 1920 × 1080 = 2,073,600 — one 1080p frame, the reference workload every GPU
 * in the device range these apps target is built to composite at 60 Hz, and the
 * number `paper.tsx` already capped its shaders at. It is the single budget for
 * the whole catalog; `paper.tsx` passes this same constant as `maxPixelCount`
 * rather than keeping a second number of its own.
 *
 * What it does and does not touch, worked out rather than asserted:
 *   • card, 343×201 at ratio 1 ................    68,943 → scale 1 (untouched)
 *   • iPhone 393×852, ratio clamped to 2 ......  1,339,344 → scale 1 (untouched)
 *   • largest phone 440×956, ratio 2 .......... 1,682,560 → scale 1 (untouched)
 *   • MacBook 1512×982, ratio 2 ............... 5,939,136 → 0.575 (ratio 1.15)
 *   • 1440p desktop, ogl default ratio 1 ...... 3,686,400 → 0.750 (ratio 0.75)
 *   • 1440p desktop, ratio 2 ..................14,745,600 → 0.375 (ratio 0.75)
 *
 * The phone rows are the reason the budget is not smaller. A phone at a ratio
 * already clamped to 2 is the cheapest full-screen mount that exists, it is the
 * device WebKit's 16-context ceiling and thermal throttling actually bite on,
 * and it is the one place where a scale below 1 would buy a visible softening
 * for no measurable win. 1.5M — the number the deleted governor used — put the
 * largest phones at 1.68M just OVER the line and quantised them to 0.9,
 * degrading exactly the device the exercise was meant to protect.
 */
export const RENDER_PIXEL_BUDGET = 1920 * 1080;

/**
 * The scale is quantised DOWN to whole fortieths.
 *
 * A continuous scale would change the drawing buffer on every one-pixel
 * viewport wiggle, and iOS address-bar and Telegram-sheet gestures emit a
 * resize per frame. Because scale ∝ 1/√area, one step costs a ~5% change in a
 * linear dimension — 170 px at 2560 wide, 100 px at 1512 — so a resize storm
 * that jitters a viewport by a few pixels cannot move the buffer at all.
 *
 * Stated precisely, because the tempting stronger claim is false: a 1-px resize
 * CAN cross a step, at the one width in ~170 where a boundary happens to sit.
 * What is guaranteed is that it can never cross more than one, and that
 * boundaries are that far apart — which is what makes churn impossible rather
 * than merely unlikely. 2.5% increments also keep the softening invisible and
 * waste under ~6% of the budget to rounding at the sizes above.
 *
 * The divisor is applied as an integer division (`n / 40`), not as a
 * multiplication by 0.025, so a representable step is exact. Where it is not
 * representable the division is correctly rounded and may land a few parts in
 * 10^16 above the true fortieth — so the buffer can exceed the budget by that
 * same relative hair. Recorded rather than papered over; it is a fraction of
 * one device pixel out of two million.
 */
export const RENDER_SCALE_STEPS = 40;

/**
 * The multiplier (0 < scale ≤ 1) that keeps a `cssWidth × cssHeight` box drawn
 * at `deviceRatio` inside {@link RENDER_PIXEL_BUDGET}.
 *
 * `deviceRatio` is whatever the caller is about to draw at — already clamped by
 * its own family's rule, since most of the catalog caps at 2 and ogl's default
 * is 1. This does not re-clamp it: the budget is about the buffer that will
 * actually be allocated, so it has to be told the truth about the ratio.
 *
 * Both axes shrink together, so the pixel count falls by `scale²` — hence the
 * square root.
 *
 * Returns exactly 1 for anything already inside the budget, and exactly 1 for
 * input it cannot reason about (SSR, jsdom's zero-size boxes, a browser that
 * reports no ratio), so a failed measurement can never blur a canvas.
 */
export function resolveRenderScale(
  cssWidth: number,
  cssHeight: number,
  deviceRatio: number
): number {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    !Number.isFinite(deviceRatio) ||
    cssWidth <= 0 ||
    cssHeight <= 0 ||
    deviceRatio <= 0
  ) {
    return 1;
  }
  const devicePixels = cssWidth * cssHeight * deviceRatio * deviceRatio;
  if (devicePixels <= RENDER_PIXEL_BUDGET) return 1;
  const raw = Math.sqrt(RENDER_PIXEL_BUDGET / devicePixels);
  // Quantise DOWNWARD: rounding to nearest could land above the budget, which
  // is the one direction this function is not allowed to be wrong in.
  const steps = Math.floor(raw * RENDER_SCALE_STEPS);
  return Math.max(steps, 1) / RENDER_SCALE_STEPS;
}

/**
 * The pixel ratio to actually allocate the buffer at: `deviceRatio` reduced by
 * {@link resolveRenderScale}.
 *
 * This is what call sites want — the whole change at each one is to compute the
 * ratio through here instead of using the raw clamp — and having it as a
 * function rather than a documented multiplication is deliberate: a call site
 * that forgot to multiply would look completely normal and cost nothing but
 * frame rate.
 *
 * The CSS width and height passed in must NOT be scaled by the result. Only the
 * buffer changes; the element keeps the size CSS gave it.
 */
export function resolveBufferRatio(
  cssWidth: number,
  cssHeight: number,
  deviceRatio: number
): number {
  return deviceRatio * resolveRenderScale(cssWidth, cssHeight, deviceRatio);
}
