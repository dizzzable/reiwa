/**
 * Card-background effect registry (reiwa SPA).
 * ───────────────────────────────────────────
 * Ported from the rezeis admin "Background Studio". These are the animated
 * ReactBits effects an operator can place BEHIND the subscription card.
 *
 * We only include the `ogl` + canvas-2D effects (reiwa ships `ogl` but NOT
 * three.js), so adding them costs zero new heavy dependencies. Each effect is
 * `React.lazy`-loaded so the WebGL/canvas code only downloads when a card
 * actually uses that effect.
 *
 * Two coordinated sources of truth, kept in lockstep with the rezeis
 * configurator registry (`web/src/features/branding/card-effect-registry.ts`):
 *   - `CARD_EFFECT_COMPONENTS` — id → lazy component.
 *   - `CARD_EFFECTS` — id → display name + tunable control defaults.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import { Aurora } from "@/components/ui/aurora";

export type CardEffectId =
  | "aurora"
  | "threads"
  | "softAurora"
  | "rippleGrid"
  | "radar"
  | "plasma"
  | "particles"
  | "liquidChrome"
  | "lineWaves"
  | "iridescence"
  | "grainient"
  | "galaxy"
  | "balatro"
  | "waves"
  | "silk"
  | "beams"
  | "dither";

type EffectComponent = LazyExoticComponent<ComponentType<Record<string, unknown>>>;

/** Lazy component map. Aurora is already bundled (card default), the rest are split. */
export const CARD_EFFECT_COMPONENTS: Record<CardEffectId, EffectComponent | ComponentType<Record<string, unknown>>> = {
  aurora: Aurora as unknown as ComponentType<Record<string, unknown>>,
  threads: lazy(() => import("./Threads")),
  softAurora: lazy(() => import("./SoftAurora")),
  rippleGrid: lazy(() => import("./RippleGrid")),
  radar: lazy(() => import("./Radar")),
  plasma: lazy(() => import("./Plasma")),
  particles: lazy(() => import("./Particles")),
  liquidChrome: lazy(() => import("./LiquidChrome")),
  lineWaves: lazy(() => import("./LineWaves")),
  iridescence: lazy(() => import("./Iridescence")),
  grainient: lazy(() => import("./Grainient")),
  galaxy: lazy(() => import("./Galaxy")),
  balatro: lazy(() => import("./Balatro")),
  waves: lazy(() => import("./Waves")),
  silk: lazy(() => import("./Silk")),
  beams: lazy(() => import("./Beams")),
  dither: lazy(() => import("./Dither")),
};

/** Default props per effect — mirrors the rezeis registry defaults. */
export const CARD_EFFECT_DEFAULTS: Record<CardEffectId, Record<string, unknown>> = {
  aurora: { colorStops: ["#5227FF", "#7cff67", "#5227FF"], amplitude: 1.0, blend: 0.5, speed: 1.0 },
  threads: { color: [1, 1, 1], amplitude: 1, distance: 0 },
  softAurora: { color1: "#f7f7f7", color2: "#e100ff", speed: 0.6, scale: 1.5, brightness: 1, noiseFrequency: 2.5 },
  rippleGrid: { gridColor: "#ffffff", rippleIntensity: 0.05, gridSize: 10, glowIntensity: 0.1, enableRainbow: false },
  radar: { color: "#9f29ff", speed: 1, ringCount: 10, spokeCount: 10, sweepSpeed: 1, brightness: 1 },
  plasma: { color: "#ffffff", speed: 1, scale: 1 },
  particles: { particleColors: ["#ffffff", "#ffffff", "#ffffff"], particleCount: 200, speed: 0.1, particleBaseSize: 100 },
  liquidChrome: { baseColor: [0.1, 0.1, 0.1], speed: 0.2, amplitude: 0.5, frequencyX: 3, frequencyY: 2 },
  lineWaves: { color1: "#ffffff", color2: "#ffffff", color3: "#ffffff", speed: 0.3, brightness: 0.2, warpIntensity: 1 },
  iridescence: { color: [1, 1, 1], speed: 1, amplitude: 0.1 },
  grainient: { color1: "#FF9FFC", color2: "#5227FF", color3: "#B497CF", timeSpeed: 0.25, grainAmount: 0.1, warpStrength: 1 },
  galaxy: { speed: 1, density: 1, hueShift: 140, glowIntensity: 0.3, twinkleIntensity: 0.3 },
  balatro: { color1: "#DE443B", color2: "#006BB4", color3: "#162325", spinSpeed: 7, spinRotation: -2, contrast: 3.5, lighting: 0.4 },
  waves: { lineColor: "#ffffff", backgroundColor: "#00000000", waveSpeedX: 0.0125, waveAmpX: 32, xGap: 10, yGap: 32 },
  silk: { speed: 5, scale: 1, color: "#7b7481", noiseIntensity: 1.5, rotation: 0 },
  beams: { lightColor: "#ffffff", speed: 2, beamWidth: 2, beamNumber: 12, noiseIntensity: 1.75, scale: 0.2 },
  dither: { waveColor: [0.5, 0.5, 0.5], waveSpeed: 0.05, waveFrequency: 3, waveAmplitude: 0.3, pixelSize: 2, colorNum: 4 },
};
