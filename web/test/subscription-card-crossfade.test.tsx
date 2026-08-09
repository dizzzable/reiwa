// @vitest-environment jsdom

/**
 * The card crossfade.
 *
 * Two complaints, one mechanism. Before this, the animated background jumped
 * from absent to fully opaque inside a single frame — filmed at 20 fps, two
 * consecutive frames 50 ms apart showed a grey card and then a finished
 * animation, with nothing in between. And because the operator's gradient sat
 * underneath and stayed there, a concept's diagonal artwork went on showing
 * through every transparent shader, which reads as a rendering fault rather
 * than as design.
 *
 * So the effect fades IN while the backdrop fades OUT, on one shared duration.
 *
 * The exception that has to survive: `css-fallback`. That mode is a
 * translucent radial built deliberately so the operator's gradient stays
 * visible, because a device without WebGL2 — every Telegram in-app browser —
 * has nothing else to show. Hiding the backdrop there would leave the card
 * nearly blank, so the fade-out is gated on a real renderer, not on readiness.
 *
 * "Out" is not always all the way out. For a shader nothing can prove the
 * effect drew, so the layer asks for a residual instead of zero — see
 * `resolveCardEffectBackdropPolicy`. The frame's job is only to apply whatever
 * fraction it is given to both backdrop layers, each against its own resting
 * value, and that is what is asserted here; which fraction each renderer gets
 * belongs to the layer and is pinned in `card-effect-blank-canvas.test.tsx`.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionCardFrame } from "../src/features/dashboard/components/subscription-card-frame";
import { resolveSubscriptionCardVisual } from "../src/features/dashboard/components/subscription-card-visual";
import { DEFAULT_BRANDING } from "../src/types/branding";

const reveal = vi.hoisted(() => ({
  current: null as ((opacity: number) => void) | null,
}));

vi.mock("@/components/reactbits/card-effect-layer", () => ({
  CARD_EFFECT_REVEAL_MS: 420,
  // A stand-in for the real layer: it exposes the callback so a test can play
  // the moment the renderer paints, without needing WebGL in jsdom.
  CardEffectLayer: ({
    onBackdropOpacityChange,
  }: {
    readonly onBackdropOpacityChange?: (opacity: number) => void;
  }) => {
    reveal.current = onBackdropOpacityChange ?? null;
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

function render(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<SubscriptionCardFrame visual={VISUAL} effectActive />);
  });
}

function layer(name: string): HTMLElement | null {
  return container?.querySelector(`[data-subscription-card-layer="${name}"]`) ?? null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reveal.current = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("subscription card crossfade", () => {
  it("shows the operator backdrop at full strength before the effect paints", () => {
    render();

    expect(layer("gradient")?.style.opacity).toBe("1");
    expect(layer("pattern")?.style.opacity).toBe("0.4");
  });

  it("gives both backdrop layers a transition so neither can snap", () => {
    render();

    expect(layer("gradient")?.style.transition).toContain("420ms");
    expect(layer("pattern")?.style.transition).toContain("420ms");
  });

  it("fades the backdrop out once a real renderer has painted", () => {
    render();
    act(() => reveal.current?.(0));

    expect(layer("gradient")?.style.opacity).toBe("0");
    expect(layer("pattern")?.style.opacity).toBe("0");
  });

  /**
   * The pattern rests at 0.4, not 1. Fading it from 1 would brighten it on the
   * way out — the texture would grow stronger before vanishing.
   */
  it("returns the pattern to its own resting opacity, not to full", () => {
    render();
    act(() => reveal.current?.(0));
    act(() => reveal.current?.(1));

    expect(layer("pattern")?.style.opacity).toBe("0.4");
  });

  it("brings the backdrop back when the effect goes away", () => {
    render();
    act(() => reveal.current?.(0));
    act(() => reveal.current?.(1));

    expect(layer("gradient")?.style.opacity).toBe("1");
  });

  it("applies a partial fade as a fraction of each layer's own resting value", () => {
    // A shader gets a residual rather than zero, because nothing can prove it
    // painted. If the frame treated the signal as a flag, this would land on
    // "0" and a silently blank shader would show an empty card — which is the
    // whole reason the layer stopped sending a boolean.
    render();
    act(() => reveal.current?.(0.12));

    expect(layer("gradient")?.style.opacity).toBe("0.12");
    expect(layer("pattern")?.style.opacity).toBe("0.048");
  });
});
