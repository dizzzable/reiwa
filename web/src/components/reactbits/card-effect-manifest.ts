/**
 * Effect id → the React component that draws it.
 *
 * Split out from `card-effect-catalog.ts` on purpose. The catalog is read by
 * contrast analysis and by the runtime policy, both of which run in plain Node
 * during tests and neither of which wants `ogl` or `three` loaded to answer a
 * question about a palette. This file is the half that does reach for the
 * renderers, and only the layer imports it.
 *
 * The map is typed `Record<CardEffectId, …>`, so an effect added to the catalog
 * without a component here — or a component here without a catalog entry — is a
 * compile error rather than a card that silently draws nothing.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import { Aurora } from "@/components/ui/aurora";

import type { CardEffectId } from "./card-effect-catalog";

export type CardEffectComponent =
  | LazyExoticComponent<ComponentType<Record<string, unknown>>>
  | ComponentType<Record<string, unknown>>;

/**
 * Each effect is `React.lazy`-loaded so its GPU/canvas code only downloads when
 * an operator has actually selected it. Aurora is the exception: it is the
 * default card effect, so splitting it would put a round trip in front of the
 * most common card in the product.
 */
export const CARD_EFFECT_COMPONENTS: Record<CardEffectId, CardEffectComponent> = {
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
  paperMesh: lazy(() => import("./paper").then((m) => ({ default: m.PaperMesh }))),
  paperWarp: lazy(() => import("./paper").then((m) => ({ default: m.PaperWarp }))),
  paperGrain: lazy(() => import("./paper").then((m) => ({ default: m.PaperGrain }))),
  paperDither: lazy(() => import("./paper").then((m) => ({ default: m.PaperDither }))),
  paperSwirl: lazy(() => import("./paper").then((m) => ({ default: m.PaperSwirl }))),
  paperMetaballs: lazy(() => import("./paper").then((m) => ({ default: m.PaperMetaballs }))),
  // Originkit — see the catalog.
  snowfall: lazy(() => import("./originkit/Snowfall")),
  stardust: lazy(() => import("./originkit/Stardust")),
  asciiRain: lazy(() => import("./originkit/AsciiRain")),
  asciiFlame: lazy(() => import("./originkit/AsciiFlame")),
  characterWaves: lazy(() => import("./originkit/CharacterWaves")),
  blinkingSquares: lazy(() => import("./originkit/BlinkingSquares")),
  lineRipple: lazy(() => import("./originkit/LineRippleBackground")),
  pulseLines: lazy(() => import("./originkit/PulseLines")),
  textWave: lazy(() => import("./originkit/TextWave")),
  pixelCard: lazy(() => import("./originkit/PixelCard")),
  glitterWrap: lazy(() => import("./originkit/GlitterWrap")),
  chromaticWaves: lazy(() => import("./originkit/ChromaticWaves")),
  dotMatrix: lazy(() => import("./originkit/DotMatrix")),
  pixelTetris: lazy(() => import("./originkit/PixelTetris")),
  risingLines: lazy(() => import("./originkit/RisingLines")),
  starBurst: lazy(() => import("./originkit/StarBurst")),
  particleTunnel: lazy(() => import("./originkit/ParticleTunnel")),
  floatingIcons: lazy(() => import("./originkit/FloatingIcons")),
  snakeGrid: lazy(() => import("./originkit/SnakeGrid")),
  gridHole: lazy(() => import("./originkit/GridHole")),
  waveArcs: lazy(() => import("./originkit/WaveArcs")),
  reactiveGrid: lazy(() => import("./originkit/ReactiveGrid")),
  reactiveLines: lazy(() => import("./originkit/ReactiveLines")),
  prismGrid: lazy(() => import("./originkit/PrismGrid")),
  thunderstrike: lazy(() => import("./originkit/Thunderstrike")),
  blackhole: lazy(() => import("./originkit/Blackhole")),
  cosmicOrb: lazy(() => import("./originkit/CosmicOrb")),
  tornado: lazy(() => import("./originkit/Tornado")),
  cube: lazy(() => import("./originkit/Cube")),
  wordGlobe: lazy(() => import("./originkit/WordGlobe")),
  particleSphere: lazy(() => import("./originkit/Particlesphere")),
};

export {
  cardEffectDefaults,
  isKnownCardEffect,
  type CardEffectId,
} from "./card-effect-catalog";
