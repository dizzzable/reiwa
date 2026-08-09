// @vitest-environment jsdom

/**
 * What counts as evidence that the effect is drawing, and what the backdrop
 * does when there is none.
 *
 * The crossfade that fades the operator's gradient out as the effect fades in
 * trusted a readiness signal that only means "the lazy component mounted". On
 * iPhone that is not the same thing: `getContext('webgl2')` can return null
 * under GPU pressure, OGL falls back to WebGL1, and a GLSL ES 3.00 shader then
 * fails to compile with nothing but a `console.warn` — no throw for the error
 * boundary, and a canvas in the DOM to satisfy the canvas observer. The card
 * used to lose its animation there and keep its gradient. With a backdrop that
 * steps aside, the same failure would leave the card EMPTY.
 *
 * Hence evidence. TWO attempts to obtain it for a shader both failed, in
 * opposite directions, and this file is what is left after admitting why:
 *
 *  - Sampling pixels. A WebGL drawing buffer is cleared at composite time
 *    unless the context asked for `preserveDrawingBuffer`, and the read is
 *    scheduled from a timer, i.e. always afterwards. Every WORKING shader in
 *    the catalog read back transparent, so no card ever revealed — at the price
 *    of five forced GPU→CPU readbacks per mount.
 *  - Asking `isContextLost()`. It answers `false` for a live context, which is
 *    precisely what the iPhone failure leaves behind: context alive, canvas
 *    blank. Evidence said "painted" for the one case it was written to catch.
 *
 * So: for WebGL, whether anything was drawn is NOT observable from JavaScript
 * after compositing. This module stops asking, and the backdrop fades to a
 * residual instead of to nothing — see `resolveCardEffectBackdropPolicy`. A 2D
 * canvas keeps its bitmap, so there the question is real and is still asked.
 *
 * Through all of it the asymmetry holds: only a definite blank answers `false`
 * and keeps the gradient, and everything unprovable answers `null`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { cardEffectRenderer } from "../src/components/reactbits/card-effect-catalog";
import {
  WEBGL_BACKDROP_RESIDUAL_OPACITY,
  resolveCardEffectBackdropPolicy,
  sampleCardEffectPainted,
} from "../src/components/reactbits/card-effect-layer-utils";

/** A real canvas-2D effect and two real shader effects, asked of the catalog. */
const CANVAS_2D_EFFECT = "waves";
const WEBGL1_EFFECT = "threads";
const WEBGL2_EFFECT = "plasma";

type Sampler = { readonly alpha: number } | "throws";
type GpuContext = "alive" | "lost" | "absent" | "throws";

/**
 * jsdom has no canvas implementation, so both the effect's canvas and the probe
 * this helper creates have to be stood in for. `alpha` is what the probe reads
 * back for every sampled pixel.
 */
function stubCanvas(sampler: Sampler, gpu: GpuContext = "absent"): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) => {
      if (kind === "webgl" || kind === "webgl2") {
        if (gpu === "throws") throw new Error("context unavailable");
        if (gpu === "absent") return null;
        return { isContextLost: () => gpu === "lost" };
      }
      if (kind !== "2d") return null;
      return {
        drawImage: () => {
          if (sampler === "throws") throw new Error("tainted or unreadable");
        },
        getImageData: () => {
          if (sampler === "throws") throw new Error("tainted or unreadable");
          const data = new Uint8ClampedArray(8 * 8 * 4);
          for (let i = 3; i < data.length; i += 4) data[i] = sampler.alpha;
          return { data };
        },
      };
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
}

function rootWithCanvas(width = 320, height = 200): HTMLElement {
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  root.append(canvas);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fixtures these tests are built on", () => {
  it("names one effect of each renderer family, from the catalog itself", () => {
    // Without this the WebGL cases below could quietly be exercising the 2D
    // branch — which is exactly the bug they exist to catch.
    expect(cardEffectRenderer(CANVAS_2D_EFFECT)).toBe("canvas2d");
    expect(cardEffectRenderer(WEBGL1_EFFECT)).toBe("webgl1");
    expect(cardEffectRenderer(WEBGL2_EFFECT)).toBe("webgl2");
  });
});

describe("paint evidence for a canvas-2D effect", () => {
  it("reports a canvas with pixels on it as painted", () => {
    stubCanvas({ alpha: 255 });

    expect(sampleCardEffectPainted(rootWithCanvas(), CANVAS_2D_EFFECT)).toBe(
      true,
    );
  });

  it("reports a canvas that is entirely transparent as not painted", () => {
    // A 2D canvas retains its contents, so "transparent after the fact" is a
    // real reading rather than an artefact of when it was taken.
    stubCanvas({ alpha: 0 });

    expect(sampleCardEffectPainted(rootWithCanvas(), CANVAS_2D_EFFECT)).toBe(
      false,
    );
  });

  it("ignores alpha low enough to be dithering rather than artwork", () => {
    stubCanvas({ alpha: 4 });

    expect(sampleCardEffectPainted(rootWithCanvas(), CANVAS_2D_EFFECT)).toBe(
      false,
    );
  });

  it("accepts faint but deliberate artwork", () => {
    stubCanvas({ alpha: 40 });

    expect(sampleCardEffectPainted(rootWithCanvas(), CANVAS_2D_EFFECT)).toBe(
      true,
    );
  });

  it("says nothing about an effect that draws without a canvas", () => {
    // A DOM- or SVG-drawn effect cannot fail the way a shader can: if React
    // rendered it, the pixels are there. `null` is the honest answer, and the
    // caller reads it as "carry on".
    const root = document.createElement("div");
    root.append(document.createElement("span"));

    expect(sampleCardEffectPainted(root, CANVAS_2D_EFFECT)).toBeNull();
  });

  it("says nothing when the drawing buffer cannot be read back", () => {
    // Refusing to read is not evidence of blankness, and must never be treated
    // as such — that is the whole asymmetry.
    stubCanvas("throws");

    expect(sampleCardEffectPainted(rootWithCanvas(), CANVAS_2D_EFFECT)).toBeNull();
  });

  it("says nothing about a canvas that has not been sized yet", () => {
    stubCanvas({ alpha: 0 });

    expect(
      sampleCardEffectPainted(rootWithCanvas(0, 0), CANVAS_2D_EFFECT),
    ).toBeNull();
  });

  it("says nothing when the probe context itself is unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    expect(sampleCardEffectPainted(rootWithCanvas(), CANVAS_2D_EFFECT)).toBeNull();
  });

  it("counts a single painted canvas among several blank ones", () => {
    // Some effects stack an offscreen buffer beside the visible one. One canvas
    // with artwork on it is enough.
    let call = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      ((kind: string) => {
        if (kind !== "2d") return null;
        return {
          drawImage: () => undefined,
          getImageData: () => {
            call += 1;
            const data = new Uint8ClampedArray(8 * 8 * 4);
            if (call === 2) for (let i = 3; i < data.length; i += 4) data[i] = 255;
            return { data };
          },
        };
      }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const root = rootWithCanvas();
    const second = document.createElement("canvas");
    second.width = 320;
    second.height = 200;
    root.append(second);

    expect(sampleCardEffectPainted(root, CANVAS_2D_EFFECT)).toBe(true);
  });
});

describe("paint evidence for a shader effect", () => {
  it("says nothing, because after compositing there is nothing to say", () => {
    // THE CONSTRAINT, stated as a test. A live context over a drawing buffer
    // that reads back empty is what a working shader looks like — and it is
    // also exactly what the iPhone compile failure looks like. Neither pixels
    // nor `isContextLost()` separates them, so the honest answer is `null`, and
    // the backdrop policy below is what makes `null` survivable.
    stubCanvas({ alpha: 0 }, "alive");

    expect(sampleCardEffectPainted(rootWithCanvas(), WEBGL1_EFFECT)).toBeNull();
    expect(sampleCardEffectPainted(rootWithCanvas(), WEBGL2_EFFECT)).toBeNull();
  });

  it.each([
    ["a live context", "alive"],
    ["a context WebKit has recycled", "lost"],
    ["no GPU context at all", "absent"],
    ["a context that cannot be interrogated", "throws"],
  ] as const)(
    "never calls a shader blank, whatever its canvas looks like (%s)",
    (_label, gpu) => {
      // THE REGRESSION THAT KILLED THE CROSSFADE. Judged on composited pixels,
      // every shader in the catalog answered `false` and no card ever revealed.
      // Whatever else changes in this branch, `false` must stay out of it.
      stubCanvas({ alpha: 0 }, gpu);

      expect(sampleCardEffectPainted(rootWithCanvas(), WEBGL1_EFFECT)).not.toBe(
        false,
      );
      expect(sampleCardEffectPainted(rootWithCanvas(), WEBGL2_EFFECT)).not.toBe(
        false,
      );
    },
  );

  it("asks a shader's canvas for nothing at all", () => {
    // Not a cost argument. `getContext` CREATES a context on a canvas that has
    // none — guaranteed on a renderer that failed to start, which is precisely
    // the low-GPU device where WebKit's sixteen-slot ceiling already bites —
    // and this code never gives it back. Per spec a later `getContext` on the
    // same canvas ignores the attributes it asks for and hands back the context
    // that already exists, so one created here would also quietly overrule the
    // renderer's own — `Dither` declines `antialias`, and would be handed the
    // multisampled backbuffer it declined.
    //
    // And `getImageData` on a composited WebGL canvas is a forced GPU→CPU
    // readback that answers nothing; the layer used to schedule five per mount,
    // and now remounts on every visibility change.
    const getContext = vi.fn(() => null);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      getContext as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );

    sampleCardEffectPainted(rootWithCanvas(), WEBGL1_EFFECT);
    sampleCardEffectPainted(rootWithCanvas(), WEBGL2_EFFECT);

    expect(getContext).not.toHaveBeenCalled();
  });

  it("says nothing about a shader effect that drew no canvas yet", () => {
    stubCanvas({ alpha: 0 }, "alive");

    expect(sampleCardEffectPainted(document.createElement("div"), WEBGL2_EFFECT))
      .toBeNull();
  });
});

describe("what the backdrop does with each of those answers", () => {
  it("takes a 2D effect's backdrop all the way out, because the evidence is real", () => {
    const policy = resolveCardEffectBackdropPolicy(CANVAS_2D_EFFECT);

    expect(policy.evidence).toBe("pixels");
    expect(policy.coveredOpacity).toBe(0);
  });

  it.each([WEBGL1_EFFECT, WEBGL2_EFFECT])(
    "leaves %s a residual instead, because there is no evidence to be had",
    (effect) => {
      const policy = resolveCardEffectBackdropPolicy(effect);

      expect(policy.evidence).toBe("none");
      expect(policy.coveredOpacity).toBe(WEBGL_BACKDROP_RESIDUAL_OPACITY);
    },
  );

  it("keeps that residual strictly between gone and untouched", () => {
    // Both ends are load-bearing, and each is a defect that has shipped.
    // Zero: a shader that silently drew nothing left an empty rectangle. One:
    // the operator's artwork reads through every working shader, which is the
    // bleed-through the fade exists to remove. The chosen value is justified
    // where it is declared; what this pins is that it stays a compromise.
    expect(WEBGL_BACKDROP_RESIDUAL_OPACITY).toBeGreaterThan(0);
    expect(WEBGL_BACKDROP_RESIDUAL_OPACITY).toBeLessThan(0.25);
  });

  it("asks nothing of an effect it has no evidence for", () => {
    // The two halves have to agree: an effect whose policy says `none` must not
    // also be sampled, or the layer waits on an answer that never comes.
    expect(resolveCardEffectBackdropPolicy(WEBGL1_EFFECT).evidence).toBe("none");
    expect(sampleCardEffectPainted(rootWithCanvas(), WEBGL1_EFFECT)).toBeNull();
  });
});
