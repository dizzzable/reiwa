/**
 * The operating range of every numeric prop an effect will accept.
 *
 * `cardEffectProps` (and `appBackground.props`) is operator-authored JSON that
 * travels panel → backend → public-config → this renderer. The panel authors it
 * with sliders that cannot leave their declared range, but nothing between the
 * slider and here re-checks the number: the backend bounds the JSON's SHAPE —
 * depth, key count, string length — and never its values, and the same record
 * can also arrive from a hand-edited database row, a direct API call, a config
 * restored from an older install, or a panel one release ahead of this bundle.
 *
 * Out of range these are not cosmetic. `beamNumber` is the count of full-screen
 * transparent planes the beams shader stacks: at the slider's ceiling of 30 it
 * is a background, at 300 it is thirty times the fill rate on a phone whose GPU
 * is already the constraint. Particle counts, shader iteration counts and grid
 * densities all have that shape. So this is a resource bound, not a validation
 * rule, and it belongs on the device it protects.
 *
 * ── Where these numbers come from ────────────────────────────────────────────
 * They are a MIRROR, not a second opinion. Every pair below is the `min`/`max`
 * of a `type: 'slider'` control in the panel's own catalog,
 * `rezeis-admin/web/src/features/branding/card-effect-catalog.ts`, which stays
 * the single source: it is where an operator's range is decided, argued in
 * comments, and changed. This file exists only because the panel's catalog
 * cannot be imported here — it lives in another repository, behind another
 * build's path alias, and it drags a form's vocabulary (labels, control types,
 * i18n keys) that has no meaning in a cabinet.
 *
 * `test/web/card-effect-catalog-parity.test.ts` compares the two files entry by
 * entry wherever both checkouts are present, so a slider whose range moves in
 * the panel and not here is a red test rather than a discovery on a subscriber's
 * phone. Do not edit a number here to make a card look different — edit the
 * panel's slider, then re-run that test.
 *
 * `step` is deliberately NOT mirrored. A step is how a slider MOVES, not what a
 * value may be; snapping to it here would move shipped defaults that sit off the
 * current grid (and several deliberately do — see the panel's comments on
 * `waves.waveSpeedX` and `paperSwirl.speed`), which is the opposite of a clamp
 * that no in-range value can notice.
 *
 * Non-slider controls are absent on purpose: colours, toggles, selects and free
 * text carry no resource cost that a number bound could express, and they are
 * already handled — `sanitizeCardEffectProps` for the dangerous key names, the
 * components' own parsing for the rest.
 */

/** `[min, max]`, both ends inclusive and both reachable from the panel. */
export type CardEffectPropRange = readonly [min: number, max: number];

export const CARD_EFFECT_NUMERIC_BOUNDS = {
  aurora: { speed: [0.1, 5], amplitude: [0.1, 3], blend: [0, 1] },
  threads: { amplitude: [0.1, 3], distance: [0, 2] },
  softAurora: {
    speed: [0.1, 3], scale: [0.5, 5], brightness: [0.1, 3], noiseFrequency: [0.5, 10],
  },
  rippleGrid: { rippleIntensity: [0.01, 0.2], gridSize: [2, 30], glowIntensity: [0, 0.5] },
  radar: {
    speed: [0.1, 5], ringCount: [3, 20], spokeCount: [3, 20], sweepSpeed: [0.1, 5],
    brightness: [0.1, 3],
  },
  plasma: { speed: [0.1, 5], scale: [0.1, 5] },
  particles: { particleCount: [50, 500], speed: [0.01, 1], particleBaseSize: [10, 300] },
  liquidChrome: {
    speed: [0.01, 1], amplitude: [0.1, 2], frequencyX: [1, 10], frequencyY: [1, 10],
  },
  lineWaves: { speed: [0.05, 2], brightness: [0.05, 1], warpIntensity: [0, 5] },
  iridescence: { speed: [0.1, 5], amplitude: [0.01, 1] },
  grainient: {
    timeSpeed: [0.05, 2], grainAmount: [0, 0.5], warpStrength: [0, 5], contrast: [0.5, 2.5],
  },
  galaxy: {
    speed: [0.1, 5], density: [0.1, 3], hueShift: [0, 360], glowIntensity: [0, 1],
    twinkleIntensity: [0, 1],
  },
  balatro: { spinSpeed: [0.5, 15], contrast: [1, 8], lighting: [0, 1] },
  waves: { waveSpeedX: [0.001, 0.05], waveAmpX: [5, 100], xGap: [2, 30], yGap: [5, 60] },
  silk: {
    speed: [0.1, 10], scale: [0.1, 5], noiseIntensity: [0, 5], rotation: [-180, 180],
  },
  beams: {
    speed: [0.5, 10], beamWidth: [0.5, 5], beamNumber: [4, 30], noiseIntensity: [0, 5],
    scale: [0.05, 1],
  },
  dither: {
    waveSpeed: [0.01, 0.2], waveFrequency: [1, 10], waveAmplitude: [0.05, 1],
    pixelSize: [1, 8], colorNum: [2, 8],
  },
  paperMesh: { speed: [0.1, 3], distortion: [0, 1], swirl: [0, 1] },
  paperWarp: {
    speed: [0.1, 5], proportion: [0, 1], softness: [0, 1], distortion: [0, 1],
    swirl: [0, 1], swirlIterations: [1, 20], shapeScale: [0, 1],
  },
  paperGrain: { speed: [0.1, 3], softness: [0, 1], intensity: [0, 1], noise: [0, 1] },
  paperDither: { speed: [0.1, 3], size: [1, 12], scale: [0.1, 2] },
  paperSwirl: {
    speed: [0.05, 2], bandCount: [1, 12], twist: [0, 1], center: [0, 1], proportion: [0, 1],
    softness: [0, 1], noiseFrequency: [0, 1], noise: [0, 1],
  },
  paperMetaballs: { speed: [0.1, 3], count: [1, 20], size: [0.1, 1], scale: [0.5, 4] },
  snowfall: {
    count: [20, 400], speedMin: [0.1, 5], speedMax: [0.1, 5], wind: [-3, 3],
    windVariation: [0, 3], sizeMin: [0.5, 6], sizeMax: [0.5, 6], opacityMin: [5, 100],
    opacityMax: [5, 100],
  },
  stardust: {
    particleDensity: [1, 8], minSize: [0.5, 5], maxSize: [0.5, 5], speed: [1, 10],
    particleSpeed: [0, 10], movement: [0, 10], angle: [0, 360],
  },
  asciiRain: {
    glyphSize: [8, 40], speed: [1, 20], angle: [-90, 90], density: [5, 55], trail: [3, 40],
  },
  asciiFlame: {
    intensity: [10, 100], decay: [5, 40], turbulence: [0, 100], thickness: [1, 8],
    windForce: [10, 100],
  },
  characterWaves: {
    elementSize: [12, 48], speed: [5, 100], waveTension: [1, 20], noiseScale: [1, 50],
    intensity: [1, 30], interactionIntensity: [0, 50], interactionRadius: [40, 400],
  },
  blinkingSquares: {
    gridSize: [8, 60], fillPercent: [10, 100], twinkleSpeed: [1, 100], opacity: [0.1, 1],
    fadePercent: [0, 100], fadeIntensity: [0, 100], cursorRadius: [40, 400],
    cursorBoost: [5, 100],
  },
  lineRipple: { count: [10, 80], movement: [2, 100], resolution: [1, 25], force: [0, 10] },
  pulseLines: {
    cornerRadius: [0, 6], paletteCount: [1, 5], speed: [0, 200], lineWidth: [1, 12],
    gap: [8, 100], scale: [0.5, 6],
  },
  textWave: {
    paletteCount: [1, 5], fontWeight: [100, 900], fontSize: [10, 48],
    letterSpacing: [-2, 8], speed: [5, 200], gap: [8, 40],
  },
  pixelCard: {
    gap: [5, 24], pixelSize: [1, 10], speed: [5, 100], padding: [0, 32],
    borderWidth: [0, 8], radius: [0, 48],
  },
  glitterWrap: {
    particleCount: [100, 700], speed: [1, 15], density: [10, 100], starSize: [2, 20],
    focalDepth: [2, 30], turbulence: [0, 10], brightness: [10, 100],
    glitterIntensity: [0, 10], trailAmount: [0, 100],
  },
  chromaticWaves: {
    frequency: [1, 10], speed: [0.5, 20], cellSize: [1, 100], gamma: [1, 20],
    paletteBias: [-10, 10],
  },
  dotMatrix: {
    frequency: [1, 10], speed: [0.5, 20], cellSize: [1, 100], gamma: [1, 20],
    paletteBias: [-10, 10], fontWeight: [100, 900], fontSizePx: [16, 96],
  },
  pixelTetris: {
    movement: [0, 10], cellSize: [10, 48], gap: [0, 6], rounded: [0, 20],
    dropSpeed: [0.5, 6],
  },
  risingLines: {
    particles: [50, 1500], riseSpeed: [0, 60], opacity: [10, 100], scale: [1, 12],
    horizonOpacity: [0, 100],
  },
  starBurst: {
    speed: [1, 40], starCount: [20, 180], centerX: [0, 100], centerY: [0, 100],
    starSize: [2, 40], opacity: [5, 100], flowerIntensity: [0, 40], twinkleSpeed: [0, 20],
  },
  particleTunnel: {
    x: [0, 100], y: [0, 100], radius: [0, 60], density: [4, 60], gap: [20, 160],
    particleSize: [1, 12], speed: [0.5, 12],
  },
  floatingIcons: {
    amount: [5, 80], minSpeed: [1, 50], maxSpeed: [1, 50], minShake: [0, 100],
    maxShake: [0, 100], coverage: [20, 150], minSize: [2, 40], maxSize: [8, 80],
  },
  snakeGrid: {
    cellSize: [16, 56], gap: [0, 6], rounded: [0, 20], speed: [2, 24], startLength: [1, 12],
    growth: [1, 6], fade: [0, 100],
  },
  gridHole: {
    speed: [10, 150], lineWidth: [0.5, 5], lines: [8, 120], discs: [10, 120],
    particleCount: [50, 500],
  },
  waveArcs: { lineWidth: [0.5, 5], lineCount: [12, 100], speed: [1, 30], glow: [4, 50] },
  reactiveGrid: {
    strokeWidth: [0.5, 6], maxSize: [16, 64], minSize: [2, 30], gap: [0, 24],
    influence: [40, 400],
  },
  reactiveLines: {
    lineWidth: [0.5, 6], minLines: [1, 40], maxLines: [5, 70], fadeIntensity: [1, 50],
  },
  prismGrid: { boxSize: [28, 90], borderWidth: [0, 5] },
  thunderstrike: {
    xOffset: [-30, 30], speed: [10, 110], intensity: [20, 120], size: [5, 60],
    angle: [-90, 90],
  },
  blackhole: {
    particleCount: [60, 600], particleSize: [1, 50], orbitSpeed: [0.5, 15], trail: [0, 50],
    tilt: [-90, 90], voidRadius: [10, 100], outerRadius: [20, 100], pullSpeed: [0, 20],
  },
  cosmicOrb: {
    zoom: [0.5, 3], speed: [5, 150], spin: [0, 150], lensAmount: [0, 100], seed: [0, 100],
  },
  tornado: {
    lineCount: [20, 200], lineGlow: [0, 10], twist: [0, 10], zoom: [40, 110],
    speed: [2, 40], dotCount: [250, 3000],
  },
  cube: {
    cubeGrid: [2, 5], dotsPerFace: [2, 5], dotSize: [1, 6], rotationX: [-12, 12],
    rotationY: [-12, 12], rotationZ: [-12, 12], sizePercent: [20, 200],
  },
  wordGlobe: {
    fontSize: [8, 40], fontWeight: [100, 900], speed: [1, 30], twist: [0, 100],
    letterSpacing: [200, 2000],
  },
  particleSphere: {
    particlesCount: [500, 4000], particleScale: [1, 10], scale: [2, 10], speed: [5, 60],
    cursorRadius: [20, 200], cursorStrength: [0, 10],
  },
} satisfies Record<string, Readonly<Record<string, CardEffectPropRange>>>;

const BOUNDS: Readonly<
  Record<string, Readonly<Record<string, CardEffectPropRange>>>
> = CARD_EFFECT_NUMERIC_BOUNDS;

/**
 * The declared ranges for `effect`, or `null` when this build has no opinion.
 *
 * `Object.hasOwn` rather than `in`, and load-bearing rather than stylistic: the
 * published config no longer restricts the effect id to a closed list, so the
 * id arriving here is arbitrary text and `'toString' in BOUNDS` is `true`.
 */
export function cardEffectNumericBounds(
  effect: string,
): Readonly<Record<string, CardEffectPropRange>> | null {
  return Object.hasOwn(BOUNDS, effect) ? BOUNDS[effect] : null;
}

/**
 * Bring an operator's numbers back inside what the panel could have produced.
 *
 * Clamped, never rejected: an odd configuration must still draw. A card that
 * refused to render because one number was out of range would be a blank
 * rectangle where the operator's artwork should be, which is strictly worse
 * than the same artwork with one parameter pinned to the end of its range.
 *
 * Three kinds of value, three answers:
 *
 *  - a finite number outside its range is pinned to the nearer end. The picture
 *    still draws, at the most extreme setting the panel itself offers;
 *  - a number that is not finite — `NaN`, `±Infinity` — is REMOVED, which is
 *    how it falls back to a declared default. Removal rather than substitution
 *    because the default depends on the effect: the catalog carries one for the
 *    effects this bundle configures itself, and deliberately carries none for
 *    the originkit components, which declare their own. Deleting the key lets
 *    whichever of those applies. This is why the call site clamps the
 *    OPERATOR's record and merges defaults UNDER the result — clamping after
 *    the merge would delete the very default it meant to fall back to;
 *  - anything else — a prop with no declared range, an effect this build has
 *    never heard of, a value that is not a number at all — is passed through
 *    untouched. An unknown configuration degrades; it never blanks.
 *
 * Returns the SAME object when nothing was out of range, so the overwhelmingly
 * common case costs one pass and no allocation, and referential equality
 * survives for anything memoising on it. That identity is also the sharpest
 * statement of the guarantee this function owes: for an in-range record it is
 * not merely equal, it is the record it was given.
 */
export function clampCardEffectProps(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const bounds = cardEffectNumericBounds(effect);
  if (bounds === null) return props;

  let corrected: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== "number") continue;
    if (!Object.hasOwn(bounds, key)) continue;

    if (!Number.isFinite(value)) {
      corrected ??= { ...props };
      delete corrected[key];
      continue;
    }
    const [min, max] = bounds[key];
    const clamped = Math.min(Math.max(value, min), max);
    // `===` and not `Object.is`: a stored `-0` against a `0` minimum is the one
    // pair these disagree about, and pinning it would rewrite a value nothing
    // can render differently.
    if (clamped === value) continue;
    corrected ??= { ...props };
    corrected[key] = clamped;
  }

  return corrected ?? props;
}
