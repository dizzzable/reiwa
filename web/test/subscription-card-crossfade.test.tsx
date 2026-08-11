// @vitest-environment jsdom

/**
 * The card backdrop under a live effect — and the crossfade that is no longer
 * half of one.
 *
 * WHAT THIS FILE USED TO PIN. The effect faded IN while the operator's gradient
 * faded OUT on one shared duration: the layer reported how much of the backdrop
 * to keep (0 where a `canvas2d` effect could be proved to have painted, a 0.12
 * residual under a shader, where nothing can prove anything), and the frame
 * applied that fraction to the gradient and to the pattern, each against its own
 * resting value.
 *
 * WHY IT NO LONGER DOES. The product owner reversed the decision: the effect
 * draws OVER the operator's gradient and nothing dims it. The admin panel's
 * preview never dimmed the gradient, so the live cabinet disagreeing with the
 * preview was the defect — not the artwork showing through a transparent
 * shader. The whole chain went with it, including the periodic pixel sampling
 * that existed only to feed it.
 *
 * So what is left to guard is the ABSENCE: both backdrop layers rest where the
 * operator set them, nothing animates them, and the frame hands the layer no
 * channel through which a dimming signal could come back. The effect's own
 * fade-in is a different mechanism and lives in
 * `card-effect-reveal-memory.test.tsx`.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionCardFrame } from "../src/features/dashboard/components/subscription-card-frame";
import { resolveSubscriptionCardVisual } from "../src/features/dashboard/components/subscription-card-visual";
import { DEFAULT_BRANDING } from "../src/types/branding";

const layerProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("@/components/reactbits/card-effect-layer", () => ({
  // A stand-in for the real layer, kept so the frame can be rendered without
  // WebGL in jsdom. It records what it was handed: the frame must not be
  // passing it anything to report back through.
  CardEffectLayer: (props: Record<string, unknown>) => {
    layerProps.current = props;
    return <div data-testid="effect-layer" />;
  },
}));

vi.mock("@/components/ui/card-watermark", () => ({
  CardWatermark: () => <div data-testid="watermark" />,
}));

// Built by the real resolver so the fixture cannot drift from the shape the
// frame actually reads.
const VISUAL = resolveSubscriptionCardVisual({
  ...DEFAULT_BRANDING,
  cardGradient: "linear-gradient(135deg, #262626 0%, #525252 100%)",
  cardPattern: "linear-gradient(#F1F3F224 1px, transparent 1px)",
  cardEffect: "aurora",
  cardEffectOpacity: 1,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(layerOpacity?: { readonly gradient: number }): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <SubscriptionCardFrame
        visual={VISUAL}
        effectActive
        layerOpacity={layerOpacity}
      />,
    );
  });
}

function layer(name: string): HTMLElement | null {
  return container?.querySelector(`[data-subscription-card-layer="${name}"]`) ?? null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  layerProps.current = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("the operator backdrop under a live effect", () => {
  it("leaves the gradient at full strength, writing no opacity of its own", () => {
    render();

    // Not `"1"`: the frame states no opacity at all for this layer outside the
    // creation reveal. A literal here would be a value something could animate.
    expect(layer("gradient")?.style.opacity).toBe("");
  });

  it("leaves the pattern at its own resting opacity", () => {
    render();

    expect(layer("pattern")?.style.opacity).toBe("0.4");
  });

  it("gives neither backdrop layer a transition, because neither moves", () => {
    // The 420 ms transition was the fade-out half of the crossfade. A
    // transition still declared here would mean something is expected to change
    // this opacity — which is exactly what was removed.
    render();

    expect(layer("gradient")?.style.transition).toBe("");
    expect(layer("pattern")?.style.transition).toBe("");
  });

  it("hands the effect layer nothing it could report a backdrop opacity through", () => {
    // Checked by SHAPE rather than by the old prop name: the mechanism came
    // back once already, and it would come back under a new name. The frame
    // passes the layer only data — effect id, props, opacity, active, class —
    // so any callback at all is a channel that should not exist.
    render();

    const received = layerProps.current ?? {};
    const callbacks = Object.entries(received).filter(
      ([, value]) => typeof value === "function",
    );

    expect(
      callbacks.map(([name]) => name),
      "the frame is passing the effect layer a callback — if it is a backdrop/paint signal, the dimming the product owner removed is being wired back in",
    ).toEqual([]);
  });

  it("still lets the creation reveal drive the gradient while it runs", () => {
    // The one thing that DOES own this opacity, and the removal must not have
    // taken it along: `layerOpacity` is the subscription-creation motion.
    render({ gradient: 0.5 });

    expect(layer("gradient")?.style.opacity).toBe("0.5");
    expect(layer("gradient")?.style.transition).toContain("560ms");
  });
});
