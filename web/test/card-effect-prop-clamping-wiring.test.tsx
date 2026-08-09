// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The clamp has to be ON THE PATH, not merely correct.
 *
 * `clampCardEffectProps` is unit-tested next door, and a unit-tested function
 * nobody calls is the exact shape of guard this project has shipped before and
 * paid for. This file asserts the only thing that unit suite cannot: that the
 * props a renderer is actually mounted with have been through it — the real
 * catalog, the real bounds table, the real merge order, and the real layer.
 *
 * Only the component map is stubbed, so the effect records what it was handed
 * instead of asking jsdom for a GPU. Everything the assertions depend on — the
 * catalog's defaults, the mirrored ranges, the order defaults merge in — is the
 * shipping code.
 */

const recorder = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock("../src/components/reactbits/card-effect-manifest", async () => {
  const catalog = await import("../src/components/reactbits/card-effect-catalog");
  const Recorder = (props: Record<string, unknown>) => {
    recorder.props = props;
    return <canvas data-test-recorder />;
  };
  return {
    CARD_EFFECT_COMPONENTS: { beams: Recorder },
    // Deliberately the real ones: the fall-back assertion below is about the
    // catalog's own default for `beams`, and a stub would let it pass against a
    // number this bundle does not ship.
    cardEffectDefaults: catalog.cardEffectDefaults,
    isKnownCardEffect: catalog.isKnownCardEffect,
  };
});

import { CardEffectLayer } from "../src/components/reactbits/card-effect-layer";
import { CARD_EFFECT_CATALOG } from "../src/components/reactbits/card-effect-catalog";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function renderBeams(props: Record<string, unknown>): void {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<CardEffectLayer effect="beams" props={props} active />));
}

describe("operator numbers reach the renderer clamped", () => {
  beforeEach(() => {
    recorder.props = null;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // `beams` is a WebGL2 shader, so the layer will not mount it until a
    // capability probe answers. jsdom has no GPU; hand the probe a context so
    // the test exercises the native path rather than the CSS fallback.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }),
    } as unknown as WebGL2RenderingContext);
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands an in-range configuration to the renderer exactly as written", () => {
    // The control the rest of this file needs: a layer that pinned everything,
    // or that ignored the operator entirely, would satisfy the cases below.
    renderBeams({ beamNumber: 20, speed: 3.5 });

    expect(recorder.props).not.toBeNull();
    expect(recorder.props?.["beamNumber"]).toBe(20);
    expect(recorder.props?.["speed"]).toBe(3.5);
  });

  it("pins a beam count no slider could have produced", () => {
    // 300 stacked full-screen transparent planes is the report this exists for.
    renderBeams({ beamNumber: 300 });

    expect(recorder.props).not.toBeNull();
    expect(
      recorder.props?.["beamNumber"],
      "the renderer was mounted with an unbounded beam count — the clamp is not on this path",
    ).toBe(30);
  });

  it("falls back to the catalog default for a non-finite number", () => {
    renderBeams({ scale: Number.POSITIVE_INFINITY });

    expect(recorder.props).not.toBeNull();
    expect(recorder.props?.["scale"]).toBe(CARD_EFFECT_CATALOG.beams.defaults.scale);
    expect(Number.isFinite(recorder.props?.["scale"])).toBe(true);
  });

  it("leaves the rest of the operator's configuration alone while pinning one prop", () => {
    renderBeams({ beamNumber: 300, lightColor: "#ff0000", noiseIntensity: 2 });

    expect(recorder.props?.["beamNumber"]).toBe(30);
    expect(recorder.props?.["lightColor"]).toBe("#ff0000");
    expect(recorder.props?.["noiseIntensity"]).toBe(2);
  });
});
