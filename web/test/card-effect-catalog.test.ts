import { describe, expect, it } from "vitest";

import {
  CARD_EFFECT_CATALOG,
  cardEffectPalette,
  cardEffectRenderer,
  isKnownCardEffect,
  requiresWebGL,
  requiresWebGL2,
} from "../src/components/reactbits/card-effect-catalog";
import { CARD_EFFECT_COMPONENTS } from "../src/components/reactbits/card-effect-manifest";

/**
 * The invariants the catalog exists to hold.
 *
 * TypeScript already forces the component map to cover exactly the catalog's
 * ids, so that is not re-litigated here except as a cheap guard against a
 * future `as` cast quietly reopening the gap. What follows is the part the type
 * system cannot see: that the classifications relate to each other correctly,
 * and that every effect carries enough information for the layer to draw
 * SOMETHING when its renderer cannot start.
 */

const IDS = Object.keys(CARD_EFFECT_CATALOG);

describe("card effect catalog", () => {
  it("describes the effects this build ships", () => {
    // Anchors the file: if the catalog were ever emptied, every `it.each` below
    // would iterate nothing and pass in silence.
    expect(IDS.length).toBeGreaterThan(20);
  });

  it("has a component for exactly the effects it describes", () => {
    expect(Object.keys(CARD_EFFECT_COMPONENTS).sort()).toEqual([...IDS].sort());
  });

  it.each(IDS)("gives %s a palette the CSS stand-in can actually draw", (id) => {
    const palette = cardEffectPalette(id);

    // An empty array typechecks perfectly and would leave the fallback
    // composing `undefined` into a gradient string.
    expect(palette.length).toBeGreaterThan(0);
    for (const color of palette) expect(typeof color).toBe("string");
  });

  it.each(IDS)("never leaves %s without a renderer", (id) => {
    expect(cardEffectRenderer(id)).not.toBeNull();
  });

  /**
   * The relationship that decides what a phone sees.
   *
   * An effect drawn on a plain canvas must never be gated behind a GPU probe:
   * doing so costs it precisely the low-capability devices it was chosen to
   * serve, and turns it into a static blur for no reason. This is the single
   * classification mistake with a visible consequence, which is why it is
   * asserted rather than assumed.
   */
  it.each(IDS)("asks nothing of the GPU for %s when it draws on a canvas", (id) => {
    if (cardEffectRenderer(id) !== "canvas2d") return;

    expect(requiresWebGL(id)).toBe(false);
    expect(requiresWebGL2(id)).toBe(false);
  });

  it("does have at least one canvas effect, so the rule above is not vacuous", () => {
    expect(IDS.filter((id) => cardEffectRenderer(id) === "canvas2d").length).toBeGreaterThan(0);
  });

  /**
   * The classification itself, pinned.
   *
   * The rule above can only catch a broken `requiresWebGL`; it cannot catch an
   * effect filed under the wrong renderer, because it simply skips anything not
   * marked `canvas2d`. Nothing in the type system can catch that either — the
   * truth lives in the component's source, in which context it asks the canvas
   * for. So the classification is restated here, established by reading each
   * component, and a change now has to be made deliberately in two places
   * instead of drifting in one.
   *
   * If you are here because this failed: check what the component actually
   * calls `getContext` with before changing the expectation.
   */
  it.each([
    ["waves", "canvas2d"],
    ["aurora", "webgl1"],
    ["threads", "webgl1"],
    ["galaxy", "webgl1"],
    ["silk", "webgl2"],
    ["dither", "webgl2"],
    ["paperWarp", "webgl2"],
  ])("still draws %s with %s", (id, renderer) => {
    expect(cardEffectRenderer(id)).toBe(renderer);
  });

  it.each(IDS)("treats %s as needing WebGL whenever it needs WebGL2", (id) => {
    if (!requiresWebGL2(id)) return;

    expect(requiresWebGL(id)).toBe(true);
  });

  it("asks nothing of the GPU for an effect it does not have", () => {
    // The layer waits for a capability probe before mounting anything that
    // needs the GPU. Claiming an unknown id needs one would make it wait for a
    // component it is never going to mount.
    expect(requiresWebGL("effectFromAFuturePanelRelease")).toBe(false);
    expect(requiresWebGL2("effectFromAFuturePanelRelease")).toBe(false);
  });

  it("asks nothing of the GPU for the absence of an effect", () => {
    expect(isKnownCardEffect("NONE")).toBe(false);
    expect(requiresWebGL("NONE")).toBe(false);
  });

  it("keeps a palette for an unknown id rather than returning nothing", () => {
    const palette = cardEffectPalette("effectFromAFuturePanelRelease");

    expect(palette.length).toBeGreaterThan(0);
  });
});
