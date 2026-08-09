/**
 * Every animated card background this bundle ships, described once.
 *
 * Before this file the same list of effect names lived in six hand-kept places
 * across two repositories: the component map, the default props, the fallback
 * palettes, the set needing WebGL2, the set drawing on a plain canvas, and the
 * set whose output escapes its input palette. Adding one effect meant finding
 * all six, and forgetting one stayed invisible until a device without WebGL2
 * showed a grey card, or a contrast check picked unreadable text.
 *
 * Each effect is now stated once here, and every one of those structures is
 * derived. The derivation is the point: a missing entry became impossible
 * rather than merely unlikely.
 *
 * Deliberately free of React and of any renderer import. Contrast analysis and
 * the runtime policy read this file, and they run in plain Node during tests;
 * pulling a component in here would drag `ogl` and `three` behind it into every
 * chunk and every test that only wanted to know an effect's palette. The
 * components live next door in `card-effect-manifest.ts`, and the type system
 * requires that map to cover exactly the ids below — no more, no fewer.
 */

/**
 * What an effect needs from the device in order to paint.
 *
 * `canvas2d` is not a lesser tier but a different one: those effects need no
 * GPU context at all, so they run where a shader cannot start and they do not
 * consume one of the handful of live WebGL contexts a mobile browser allows.
 * Filing a canvas effect as `webgl1` costs it exactly the devices it was chosen
 * for.
 */
export type CardEffectRenderer = "canvas2d" | "webgl1" | "webgl2";

export interface CardEffectEntry {
  readonly renderer: CardEffectRenderer;
  /** Props applied beneath the operator's, so every prop always has a value. */
  readonly defaults: Record<string, unknown>;
  /**
   * Colours for the static stand-in drawn when the real renderer cannot run,
   * and the input side of the card's text-contrast analysis.
   */
  readonly palette: readonly string[];
  /**
   * Set when the shader can emit colours outside the palette it was given —
   * additive blending, glow, procedural noise, post-contrast. Contrast analysis
   * then has to assume both display extremes instead of trusting the operator's
   * uniforms.
   */
  readonly fullOutputGamut?: true;
}

export const DEFAULT_CARD_EFFECT_PALETTE = ["#5227FF", "#7CFF67", "#5227FF"] as const;

export const CARD_EFFECT_CATALOG = {
  aurora: {
    renderer: "webgl1",
    defaults: { colorStops: ["#5227FF", "#7cff67", "#5227FF"], amplitude: 1.0, blend: 0.5, speed: 1.0 },
    palette: DEFAULT_CARD_EFFECT_PALETTE,
  },
  threads: {
    renderer: "webgl1",
    defaults: { color: [1, 1, 1], amplitude: 1, distance: 0 },
    palette: ["#ffffff"],
  },
  softAurora: {
    renderer: "webgl1",
    defaults: { color1: "#f7f7f7", color2: "#e100ff", speed: 0.6, scale: 1.5, brightness: 1, noiseFrequency: 2.5 },
    palette: ["#f7f7f7", "#e100ff"],
    fullOutputGamut: true,
  },
  rippleGrid: {
    renderer: "webgl1",
    defaults: { gridColor: "#ffffff", rippleIntensity: 0.05, gridSize: 10, glowIntensity: 0.1, enableRainbow: false },
    palette: ["#ffffff"],
    fullOutputGamut: true,
  },
  radar: {
    renderer: "webgl1",
    defaults: { color: "#9f29ff", speed: 1, ringCount: 10, spokeCount: 10, sweepSpeed: 1, brightness: 1 },
    palette: ["#9f29ff", "#000000"],
    fullOutputGamut: true,
  },
  plasma: {
    renderer: "webgl2",
    defaults: { color: "#ffffff", speed: 1, scale: 1 },
    palette: ["#ffffff", "#000000"],
  },
  particles: {
    renderer: "webgl1",
    defaults: { particleColors: ["#ffffff", "#ffffff", "#ffffff"], particleCount: 200, speed: 0.1, particleBaseSize: 100 },
    palette: ["#ffffff"],
    fullOutputGamut: true,
  },
  liquidChrome: {
    renderer: "webgl1",
    defaults: { baseColor: [0.1, 0.1, 0.1], speed: 0.2, amplitude: 0.5, frequencyX: 3, frequencyY: 2 },
    palette: ["#1a1a1a", "#000000", "#ffffff"],
    fullOutputGamut: true,
  },
  lineWaves: {
    renderer: "webgl1",
    defaults: { color1: "#ffffff", color2: "#ffffff", color3: "#ffffff", speed: 0.3, brightness: 0.2, warpIntensity: 1 },
    palette: ["#ffffff"],
    fullOutputGamut: true,
  },
  iridescence: {
    renderer: "webgl1",
    defaults: { color: [1, 1, 1], speed: 1, amplitude: 0.1 },
    palette: ["#ffffff", "#000000"],
  },
  grainient: {
    renderer: "webgl2",
    defaults: { color1: "#FF9FFC", color2: "#5227FF", color3: "#B497CF", timeSpeed: 0.25, grainAmount: 0.1, warpStrength: 1, contrast: 1.5 },
    palette: ["#ff9ffc", "#5227ff", "#b497cf"],
    fullOutputGamut: true,
  },
  galaxy: {
    renderer: "webgl1",
    defaults: { speed: 1, density: 1, hueShift: 140, glowIntensity: 0.3, twinkleIntensity: 0.3 },
    palette: ["#ffffff", "#000000"],
    fullOutputGamut: true,
  },
  balatro: {
    renderer: "webgl1",
    defaults: { color1: "#DE443B", color2: "#006BB4", color3: "#162325", spinSpeed: 7, spinRotation: -2, contrast: 3.5, lighting: 0.4 },
    palette: ["#de443b", "#006bb4", "#162325"],
    fullOutputGamut: true,
  },
  waves: {
    renderer: "canvas2d",
    defaults: { lineColor: "#ffffff", backgroundColor: "#00000000", waveSpeedX: 0.0125, waveAmpX: 32, xGap: 10, yGap: 32 },
    palette: ["#ffffff", "#00000000"],
  },
  silk: {
    // Three/Fiber asks its renderer for a WebGL2 context.
    renderer: "webgl2",
    defaults: { speed: 5, scale: 1, color: "#7b7481", noiseIntensity: 1.5, rotation: 0 },
    palette: ["#7b7481"],
  },
  beams: {
    renderer: "webgl2",
    defaults: { lightColor: "#ffffff", speed: 2, beamWidth: 2, beamNumber: 12, noiseIntensity: 1.75, scale: 0.2 },
    palette: ["#ffffff", "#000000"],
  },
  dither: {
    renderer: "webgl2",
    defaults: { waveColor: [0.5, 0.5, 0.5], waveSpeed: 0.05, waveFrequency: 3, waveAmplitude: 0.3, pixelSize: 2, colorNum: 4 },
    palette: ["#808080", "#000000"],
  },
  paperMesh: {
    renderer: "webgl2",
    defaults: { colors: ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"], distortion: 0.8, swirl: 0.1, speed: 1 },
    palette: ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"],
  },
  paperWarp: {
    renderer: "webgl2",
    defaults: { colors: ["#121212", "#9470ff", "#121212", "#8838ff"], proportion: 0.45, softness: 1, distortion: 0.25, swirl: 0.8, swirlIterations: 10, shapeScale: 0.1, shape: "checks", speed: 1 },
    palette: ["#121212", "#9470ff", "#8838ff"],
  },
  paperGrain: {
    renderer: "webgl2",
    defaults: { colorBack: "#000000", colors: ["#7300ff", "#eba8ff", "#00bfff", "#2a00ff"], softness: 0.5, intensity: 0.5, noise: 0.25, shape: "corners", speed: 1 },
    palette: ["#000000", "#7300ff", "#eba8ff", "#00bfff", "#2a00ff"],
  },
  paperDither: {
    renderer: "webgl2",
    defaults: { colorBack: "#000000", colorFront: "#00b2ff", shape: "sphere", type: "4x4", size: 2, scale: 0.6, speed: 1 },
    palette: ["#000000", "#00b2ff"],
  },
  paperSwirl: {
    renderer: "webgl2",
    defaults: { colorBack: "#000000", colors: ["#ffd1d1", "#ff8a8a", "#660000"], bandCount: 4, twist: 0.1, center: 0.2, proportion: 0.5, softness: 0, noiseFrequency: 0.4, noise: 0.2, speed: 0.32 },
    palette: ["#000000", "#ffd1d1", "#ff8a8a", "#660000"],
  },
  paperMetaballs: {
    renderer: "webgl2",
    defaults: { colorBack: "#000000", colors: ["#6e33cc", "#ff5500", "#ffc105", "#ffc800", "#f585ff"], count: 10, size: 0.83, speed: 1 },
    palette: ["#000000", "#6e33cc", "#ff5500", "#ffc105", "#f585ff"],
  },

  // ── Originkit ─────────────────────────────────────────────────────────
  // `defaults` is empty on purpose. Every one of these components declares
  // its own default for every prop, and the file declaring them is the SAME
  // file the panel previews — byte-frozen across both trees. Restating the
  // values here would create a second copy that can disagree with the
  // component, which is the class of bug this catalog exists to end.
  snowfall: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  stardust: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  asciiRain: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#f7ff00", "#000000"],
  },
  asciiFlame: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#000000", "#b93608", "#ff8b18", "#ffc247"],
  },
  characterWaves: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  blinkingSquares: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#bb29ff", "#000000"],
  },
  lineRipple: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  pulseLines: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#222222", "#000000"],
  },
  textWave: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  pixelCard: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#27272a", "#000000"],
  },
  glitterWrap: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
    fullOutputGamut: true,
  },
  chromaticWaves: {
    renderer: "webgl2",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  dotMatrix: {
    renderer: "webgl2",
    defaults: {},
    palette: ["#ffffff", "#e07000", "#000000"],
  },
  pixelTetris: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#f9731a", "#ffffff", "#000000"],
    fullOutputGamut: true,
  },
  risingLines: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#c918f8", "#000000"],
    fullOutputGamut: true,
  },
  starBurst: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
    fullOutputGamut: true,
  },
  particleTunnel: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  floatingIcons: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#dd2e44", "#000000"],
    fullOutputGamut: true,
  },
  snakeGrid: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#f9731a", "#000000"],
  },
  gridHole: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
    fullOutputGamut: true,
  },
  waveArcs: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#0a0a0a"],
  },
  reactiveGrid: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  reactiveLines: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#0a0a0a"],
  },
  prismGrid: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#ffc2e3", "#deffea", "#dfc2ff", "#000000"],
  },
  thunderstrike: {
    renderer: "webgl1",
    defaults: {},
    palette: ["#593c0c", "#000000"],
    fullOutputGamut: true,
  },
  blackhole: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  cosmicOrb: {
    renderer: "webgl1",
    defaults: {},
    palette: ["#6a3cff", "#3ce0ff", "#a24bff", "#ff5ea8", "#000000"],
    fullOutputGamut: true,
  },
  tornado: {
    renderer: "webgl2",
    defaults: {},
    palette: ["#ffffff", "#f9731a", "#000000"],
    fullOutputGamut: true,
  },
  cube: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  wordGlobe: {
    renderer: "canvas2d",
    defaults: {},
    palette: ["#ffffff", "#000000"],
  },
  particleSphere: {
    renderer: "webgl2",
    defaults: {},
    palette: ["#ffffff", "#000000"],
    fullOutputGamut: true,
  },
} satisfies Record<string, CardEffectEntry>;

/**
 * Every effect this bundle can draw.
 *
 * `"NONE"` is not among them: that is the operator asking for no animation,
 * which the layer settles before it looks anything up here.
 */
export type CardEffectId = keyof typeof CARD_EFFECT_CATALOG;

const ENTRIES: Readonly<Record<string, CardEffectEntry>> = CARD_EFFECT_CATALOG;

/**
 * Whether this build actually ships `id`.
 *
 * The published config no longer restricts `cardEffect` to a closed list, so a
 * newer rezeis-admin cannot freeze an older cabinet — see `isEffectId` in
 * `src/application/ports/public-config-persistence.port.ts`. The id arriving
 * here is therefore arbitrary text, which makes `Object.hasOwn` load-bearing
 * rather than stylistic: `"toString" in CARD_EFFECT_CATALOG` is `true`, and the
 * lookup after it would hand `Object.prototype.toString` to React as though it
 * were a component.
 */
export function isKnownCardEffect(id: string): id is CardEffectId {
  return Object.hasOwn(ENTRIES, id);
}

function entryFor(id: string): CardEffectEntry | null {
  return isKnownCardEffect(id) ? ENTRIES[id] : null;
}

/** Default props for `id`, or an empty set when this build has no such effect. */
export function cardEffectDefaults(id: string): Record<string, unknown> {
  return entryFor(id)?.defaults ?? {};
}

/** The static palette for `id`, falling back to the default card artwork. */
export function cardEffectPalette(id: string): readonly string[] {
  return entryFor(id)?.palette ?? DEFAULT_CARD_EFFECT_PALETTE;
}

export function cardEffectRenderer(id: string): CardEffectRenderer | null {
  return entryFor(id)?.renderer ?? null;
}

export function hasFullOutputGamut(id: string): boolean {
  return entryFor(id)?.fullOutputGamut === true;
}

/**
 * Whether `id` cannot start without a WebGL2 context.
 *
 * Answered from the entry rather than from a separate list, so an effect added
 * without a renderer does not typecheck — which is precisely the omission that
 * used to be silent.
 */
export function requiresWebGL2(id: string): boolean {
  return cardEffectRenderer(id) === "webgl2";
}

/** Whether `id` needs a GPU context at all. Canvas effects do not. */
export function requiresWebGL(id: string): boolean {
  const renderer = cardEffectRenderer(id);
  // `"NONE"` and any unrecognised id draw nothing, so they need nothing.
  // Claiming otherwise would make the layer wait on a capability probe for a
  // component it is never going to mount.
  return renderer !== null && renderer !== "canvas2d";
}
