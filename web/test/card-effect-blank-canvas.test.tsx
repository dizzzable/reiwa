// @vitest-environment jsdom

/**
 * The blank-canvas regression, end to end — and the two regressions that the
 * fixes for it introduced.
 *
 * `card-effect-paint-evidence.test.ts` pins the evidence decision in isolation.
 * This file pins the thing that actually matters: what the frame is told, and
 * therefore how much of the operator's backdrop is left on the card.
 *
 * Three failures pull against each other and all three have happened.
 *
 * A card whose effect draws nothing must keep the operator's gradient. That is
 * the iPhone report: `getContext('webgl2')` returns null under GPU pressure, OGL
 * drops to WebGL1, a GLSL ES 3.00 shader fails to compile with only a
 * `console.warn` — no throw for the error boundary, and a canvas in the DOM for
 * the canvas observer. Before the backdrop learned to step aside that cost the
 * card its animation; afterwards it would have cost the card everything.
 *
 * And a card whose effect DOES draw must lose the gradient, or the crossfade is
 * dead code. That is what pixel-sampling every renderer produced: a WebGL
 * drawing buffer is cleared at composite time, the sample is taken from a timer
 * afterwards, so every working shader read back empty and no card ever revealed.
 *
 * And for a shader those two cases are INDISTINGUISHABLE from JavaScript. A
 * second attempt to tell them apart — asking `isContextLost()` — reported the
 * live-context-over-blank-canvas failure as painted, which is the exact case it
 * was written for. So the layer no longer decides between them: a shader takes
 * the backdrop DOWN rather than OUT, and both failures cost a dimmed gradient
 * rather than an empty card or a dead crossfade. A `canvas2d` effect keeps its
 * bitmap, can be asked, and still fades the backdrop away completely. Both
 * families are asserted below, on the same layer and the same stubs.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `threads` is `webgl1` in the real catalog and `waves` is `canvas2d`, and the
// catalog is deliberately NOT mocked: which branch of the evidence check an
// effect takes is a fact about the catalog, and a test that mocked it away
// would prove nothing about either.
vi.mock("../src/components/reactbits/card-effect-manifest", () => {
  const components = {
    threads: () => <canvas data-test-effect />,
    waves: () => <canvas data-test-effect />,
  };
  const defaults: Record<string, Record<string, unknown>> = {
    threads: {},
    waves: {},
  };
  return {
    CARD_EFFECT_COMPONENTS: components,
    CARD_EFFECT_DEFAULTS: defaults,
    isKnownCardEffect: (id: string) => Object.hasOwn(components, id),
    cardEffectDefaults: (id: string) => (Object.hasOwn(defaults, id) ? defaults[id] : {}),
  };
});

import { CardEffectLayer } from "../src/components/reactbits/card-effect-layer";
import { WEBGL_BACKDROP_RESIDUAL_OPACITY } from "../src/components/reactbits/card-effect-layer-utils";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

/**
 * One stub for two different callers: the capability probe wants a WebGL
 * context it can get an extension from, and the 2D evidence check wants a
 * context it can read pixels back from. `paintedAlpha` is what the latter sees.
 * Nothing asks a shader's canvas anything any more, which is its own assertion
 * in `card-effect-paint-evidence.test.ts`.
 */
function stubContexts({ paintedAlpha }: { readonly paintedAlpha: number }): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) => {
      if (kind === "webgl" || kind === "webgl2") {
        return {
          getExtension: () => ({ loseContext: () => undefined }),
          isContextLost: () => false,
        };
      }
      if (kind !== "2d") return null;
      return {
        drawImage: () => undefined,
        getImageData: () => {
          const data = new Uint8ClampedArray(8 * 8 * 4);
          for (let i = 3; i < data.length; i += 4) data[i] = paintedAlpha;
          return { data };
        },
      };
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
}

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  // Only `setTimeout` is faked. Vitest's fake timers otherwise take over
  // `requestAnimationFrame` as well, which would displace the synchronous stub
  // above and leave the capability probe and the reveal both waiting on a clock
  // this test is trying to drive past them.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  act(() => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted.splice(0)) container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Long enough for every sampling attempt the layer will make. */
function letSamplingFinish(): void {
  act(() => {
    vi.advanceTimersByTime(2_000);
  });
}

describe("a shader effect", () => {
  it("dims the backdrop rather than removing it", () => {
    // THE FIX FOR THE FIX. This card looks identical, from JavaScript, whether
    // the shader is painting beautifully or failed to compile and is showing
    // nothing. Fading the backdrop out would be correct in one case and would
    // leave an empty rectangle in the other, and there is no third source of
    // truth. So it fades DOWN.
    const onBackdropOpacityChange = vi.fn();
    stubContexts({ paintedAlpha: 0 });

    render(
      <CardEffectLayer
        effect="threads"
        active
        onBackdropOpacityChange={onBackdropOpacityChange}
      />,
    );
    letSamplingFinish();

    expect(onBackdropOpacityChange).toHaveBeenLastCalledWith(
      WEBGL_BACKDROP_RESIDUAL_OPACITY,
    );
  });

  it("never asks for the backdrop to disappear entirely", () => {
    // The half that guards the empty card. Stated separately from the value
    // above so that lowering the residual to zero cannot pass as a tweak.
    const onBackdropOpacityChange = vi.fn();
    stubContexts({ paintedAlpha: 0 });

    render(
      <CardEffectLayer
        effect="threads"
        active
        onBackdropOpacityChange={onBackdropOpacityChange}
      />,
    );
    letSamplingFinish();

    expect(onBackdropOpacityChange).not.toHaveBeenCalledWith(0);
  });

  it("does step the backdrop back, so the crossfade is not dead code", () => {
    // The other half. Every working shader read back as an empty buffer, which
    // is why this once reported "untouched" forever.
    const onBackdropOpacityChange = vi.fn();
    stubContexts({ paintedAlpha: 0 });

    render(
      <CardEffectLayer
        effect="threads"
        active
        onBackdropOpacityChange={onBackdropOpacityChange}
      />,
    );
    letSamplingFinish();

    const [last] = onBackdropOpacityChange.mock.lastCall as [number];
    expect(last).toBeLessThan(1);
  });

  it("still mounts the renderer, because the failure is invisible from here", () => {
    // The point of the regression: nothing about this looks wrong. The
    // component mounted, the canvas is in the DOM, no error was thrown.
    stubContexts({ paintedAlpha: 0 });

    const container = render(<CardEffectLayer effect="threads" active />);
    letSamplingFinish();

    expect(container.querySelector("[data-test-effect]")).not.toBeNull();
    expect(
      container
        .querySelector("[data-card-effect-runtime]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("native");
  });

  it("hands the whole backdrop back when the context is lost under it", () => {
    // The one shader failure still observable, and it is observable as an EVENT
    // rather than as a state: `observeCardEffectCanvases` listens, the runtime
    // drops to the CSS fallback, and that mode never covers the backdrop at
    // all. Polling `isContextLost()` is what this replaces.
    const onBackdropOpacityChange = vi.fn();
    stubContexts({ paintedAlpha: 0 });

    const container = render(
      <CardEffectLayer
        effect="threads"
        active
        onBackdropOpacityChange={onBackdropOpacityChange}
      />,
    );
    letSamplingFinish();
    act(() => {
      container
        .querySelector("canvas")
        ?.dispatchEvent(new Event("webglcontextlost"));
    });
    letSamplingFinish();

    expect(
      container
        .querySelector("[data-card-effect-runtime]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("css-fallback");
    expect(onBackdropOpacityChange).toHaveBeenLastCalledWith(1);
  });

  it("puts the backdrop back when it goes away", () => {
    const onBackdropOpacityChange = vi.fn();
    stubContexts({ paintedAlpha: 0 });

    render(
      <CardEffectLayer
        effect="threads"
        active
        onBackdropOpacityChange={onBackdropOpacityChange}
      />,
    );
    letSamplingFinish();
    act(() => {
      for (const { root } of mounted) root.unmount();
    });

    expect(onBackdropOpacityChange).toHaveBeenLastCalledWith(1);
  });
});

describe("a canvas-2D effect", () => {
  it("never covers the backdrop at all when it paints nothing", () => {
    // A 2D canvas keeps its bitmap, so a transparent read here is a real
    // reading and not an artefact of when it was taken. Evidence exists, so it
    // is required.
    const onBackdropOpacityChange = vi.fn();
    stubContexts({ paintedAlpha: 0 });

    render(
      <CardEffectLayer
        effect="waves"
        active
        onBackdropOpacityChange={onBackdropOpacityChange}
      />,
    );
    letSamplingFinish();

    expect(onBackdropOpacityChange).toHaveBeenLastCalledWith(1);
  });

  it("takes the backdrop all the way out once it has painted", () => {
    // The whole point of keeping the sampler: where the answer is real, the
    // backdrop pays nothing for the shader's uncertainty.
    const onBackdropOpacityChange = vi.fn();
    stubContexts({ paintedAlpha: 255 });

    render(
      <CardEffectLayer
        effect="waves"
        active
        onBackdropOpacityChange={onBackdropOpacityChange}
      />,
    );
    letSamplingFinish();

    expect(onBackdropOpacityChange).toHaveBeenLastCalledWith(0);
  });
});

describe("the two renderer families, side by side", () => {
  it("settle on different backdrops from identical surroundings", () => {
    // Same layer, same stubs, same empty jsdom canvas — the ONLY difference is
    // what the catalog says draws it, and therefore whether the question can be
    // asked. If these two ever agree again, one of them is guessing.
    const shader = vi.fn();
    const canvas2d = vi.fn();
    stubContexts({ paintedAlpha: 255 });

    render(
      <CardEffectLayer effect="threads" active onBackdropOpacityChange={shader} />,
    );
    render(
      <CardEffectLayer effect="waves" active onBackdropOpacityChange={canvas2d} />,
    );
    letSamplingFinish();

    expect(canvas2d).toHaveBeenLastCalledWith(0);
    expect(shader).toHaveBeenLastCalledWith(WEBGL_BACKDROP_RESIDUAL_OPACITY);
  });
});
