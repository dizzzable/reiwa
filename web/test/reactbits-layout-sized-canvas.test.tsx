// @vitest-environment jsdom

/**
 * The three fiber-backed effects must measure their LAYOUT box, not their
 * painted one.
 *
 * WHY THIS EXISTS. fiber measures with react-use-measure, whose default is
 * `getBoundingClientRect()` — TRANSFORMED geometry — and then writes that
 * measurement straight back into `canvas.style.width/height`, which is a
 * LAYOUT property. The two disagree under any ancestor transform, and fiber
 * ends up scaling the canvas by the transform so the browser can scale it
 * again. `offsetSize: true` swaps the measurement for offsetWidth/offsetHeight,
 * which a transform cannot see, and closes that loop.
 *
 * It is reachable: the panel's card-effect preview tiles carry
 * `hover:scale-[1.03]`, and react-use-measure re-measures on scroll.
 *
 * This file used to justify the same option by a `transform: scale()`
 * resolution governor in `AppBackground`. That governor has been deleted — it
 * changed the picture, was inert for the twenty effects that measure with gBCR,
 * and clipped `prismGrid` — and the drawing buffer is now capped inside each
 * effect instead (`render-scale.ts`). The option survives it because the reason
 * above never depended on it.
 *
 * HOW IT IS ASSERTED WITHOUT A GPU. The literal proof would be the GL drawing
 * buffer's dimensions, and jsdom has no GL. But fiber refuses to build a
 * renderer at all while the size it measured is zero — and jsdom hands every
 * element a layout box of exactly 0×0 while letting `getBoundingClientRect()`
 * be stubbed to anything. So a container that PAINTS at 800×600 and LAYS OUT
 * at 0×0 splits the two measurements cleanly:
 *   - measuring layout  → 0×0 → fiber never asks the canvas for a context;
 *   - measuring paint   → 800×600 → fiber builds a renderer, and the first
 *     thing three.js does is `getContext` on that canvas.
 * So `getContext` was never called IS the assertion that the layout box is
 * what these components size themselves from, and it exercises the real chain
 * end to end — component prop → fiber → the installed react-use-measure —
 * with nothing mocked in the middle.
 *
 * What is NOT asserted here, stated so it is not assumed: that three.js then
 * multiplies that size by the pixel ratio into the actual buffer. That is
 * `WebGLRenderer.setSize`'s documented contract and needs a GPU to observe.
 * `react-use-measure-offset-size.test.tsx` pins the other half — that the
 * INSTALLED react-use-measure really does switch to offsetWidth/offsetHeight —
 * because that is the link a dependency bump could remove without a sound.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neither barrel is under test, and both are only ever rendered as fiber
// children — which never happens here, because fiber has no root to render
// into. Stubbing them keeps the module graph small; fiber and
// react-use-measure, the two links being tested, are deliberately real.
vi.mock("@react-three/drei", () => ({ PerspectiveCamera: () => null }));
vi.mock("@react-three/postprocessing", () => ({
  EffectComposer: () => null,
  wrapEffect: () => () => null,
}));
vi.mock("postprocessing", () => ({
  Effect: class {
    constructor(..._args: unknown[]) {}
  },
}));

import Beams from "../src/components/reactbits/Beams";
import Dither from "../src/components/reactbits/Dither";
import Silk from "../src/components/reactbits/Silk";

/** The painted box: what `getBoundingClientRect()` reports. */
const PAINTED = { width: 800, height: 600 };

/**
 * react-use-measure throws on construction without a ResizeObserver, and jsdom
 * has none. It never has to fire: the measurement this test needs is driven by
 * a window `resize` instead, which react-use-measure runs UNDEBOUNCED under
 * fiber's options (`debounce.resize: 0`) while its observer callback is the
 * scroll-debounced one. Waiting out that 50 ms timer would work and would make
 * the test's determinism depend on a third party's default.
 */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
let getContext: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Re-stubbed per test rather than once for the file: `unstubAllGlobals`
  // below clears every stub, and React silently stops honouring act() the
  // moment this flag goes missing.
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
  });
  // jsdom leaves offsetWidth/offsetHeight at 0 for every element, which is the
  // layout box this test wants — it is deliberately NOT stubbed.
  getContext = vi.fn(() => null);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    getContext as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(element: ReactElement): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  // Async, because fiber configures its renderer from an async function: a
  // synchronous act() would return before the renderer it must not build had
  // a chance to be built, and the test would pass for the wrong reason.
  await act(async () => {
    root.render(element);
  });
  // The measurement. Mounting alone leaves react-use-measure on its initial
  // 0×0 state, which every variant of this component would pass — the resize
  // is what makes it read the element and therefore what makes the layout box
  // and the painted box tell each other apart.
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe.each([
  ["beams", <Beams key="beams" />],
  ["silk", <Silk key="silk" />],
  ["dither", <Dither key="dither" />],
])("%s sizes its drawing buffer from layout, not from paint", (_id, element) => {
  it("starts no renderer for a box that only PAINTS at 800×600", async () => {
    await mount(element);

    // If this fails, the component measured getBoundingClientRect(): it built a
    // renderer for the painted 800×600 instead of the 0×0 it is laid out at,
    // which is the state in which fiber writes painted pixels into a layout
    // property and double-scales its own canvas under any transform.
    expect(getContext).not.toHaveBeenCalled();
  });
});
