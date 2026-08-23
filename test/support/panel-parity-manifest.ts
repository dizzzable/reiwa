/**
 * THE PANEL'S SIDE OF THE PARITY SURFACE, COMMITTED HERE.
 *
 * ── WHY A COPY EXISTS AT ALL ────────────────────────────────────────────────
 * Three specs in this repository guard parity with `rezeis/rezeis-admin` by
 * reading that repository's SOURCE TEXT out of a sibling checkout. reiwa's CI
 * (`.github/workflows/ci.yml`) checks out reiwa alone, so in CI the sibling is
 * absent and every one of those cases SKIPS — 49 of them. They guarded a
 * developer machine that happened to hold both trees, and nothing else.
 *
 * This file is the panel's half of that surface, written down, so those cases
 * have something to run against everywhere. It is NOT a second source of truth
 * left unattended:
 *
 *   - each of the three specs states a DIGEST literal of its own section and
 *     re-computes it from the data below, so this file cannot be edited
 *     without the edit being deliberate and visible in the diff;
 *   - `rezeis-admin/test/reiwa-parity-digest.spec.ts` states THE SAME three
 *     literals and computes them from the panel's LIVE sources, so the panel
 *     cannot change this surface without its own CI going red;
 *   - every value below is pushed through the cabinet's real guards, resolvers
 *     and renderers by the cases that used to skip;
 *   - when the sibling checkout IS present, each spec additionally compares the
 *     live panel against this file and names the exact value that differs.
 *
 * ── WHAT IS AND IS NOT IN HERE ──────────────────────────────────────────────
 * The digest is over MEANING, not bytes. What survives normalisation: every
 * string value, every numeric bound and slider default, the boolean flags, the
 * set of ids and props, and ARRAY ORDER (a picker's order and the extension
 * list's order are both things a human sees). What is normalised away: object
 * KEY order, comments, whitespace, quote style, `as const` / `satisfies`
 * wrappers, and how a negative number is spelled — none of which change what an
 * operator picks or a subscriber sees.
 *
 * Deliberately absent, because they are not part of the compared surface and
 * requiring them to match would fail on changes that harm nobody: the panel's
 * `palette`, `label` and `step`, its non-slider controls, and the cabinet's own
 * `defaults` block.
 *
 * ── REGENERATING ────────────────────────────────────────────────────────────
 * Read the panel's sources with the same readers the specs already carry and
 * paste the result. Whoever does that MUST also update the matching digest
 * literal in BOTH repositories in the SAME change — the specs will say which.
 *
 * GENERATED FROM THE PANEL CHECKOUT. Hand edits are allowed and will be caught
 * by the digest; they are not silently absorbed.
 */


export interface PanelUploadHeader {
  readonly name: string;
  readonly value: string;
  /** The call sits inside the markup `if`, so it does not apply to every upload. */
  readonly markupOnly: boolean;
}

export interface PanelUploadPolicy {
  /** `MARKUP_UPLOAD_EXTENSIONS`, in declaration order. */
  readonly markupExtensions: readonly string[];
  /** Every `res.setHeader(...)` in the helper, sorted by header name. */
  readonly headers: readonly PanelUploadHeader[];
}

export interface PanelSlider {
  readonly min: number;
  readonly max: number;
  /** `null` when the control declares no numeric default. */
  readonly default: number | null;
}

export interface PanelCardEffect {
  readonly renderer: string;
  readonly fullOutputGamut: boolean;
  /** Every `type: 'slider'` control, keyed by the prop it drives. */
  readonly sliders: Readonly<Record<string, PanelSlider>>;
}

export interface PanelBrandingVocabulary {
  readonly vocabularies: Readonly<Record<string, readonly string[]>>;
  /** `NAV_MAX_VISIBLE` — a number, not a list, so it is carried as one. */
  readonly navMaxVisible: number;
  /** Counts read out of the DTO's raw text; see the note above. */
  readonly dtoBorderRadius: { readonly declarations: number; readonly validators: number };
  /**
   * Every `@IsIn([...])` vocabulary the DTO spells out inline rather than
   * importing. Each list is SORTED and so is the outer list: `@IsIn` is a set
   * membership test, so the order a decorator lists its members in changes
   * nothing an operator or a subscriber can see.
   */
  readonly dtoIsInVocabularies: readonly (readonly string[])[];
}

/** `MARKUP_UPLOAD_EXTENSIONS` + `applyUploadResponseHeaders` in `src/main.ts`. */
export const PANEL_UPLOAD_POLICY: PanelUploadPolicy = {
  markupExtensions: [
    ".svg",
    ".svgz",
    ".xml",
    ".xhtml",
    ".html",
    ".htm",
    ".xht",
  ],
  headers: [
    { name: "Content-Disposition", value: "attachment", markupOnly: true },
    { name: "Content-Security-Policy", value: "default-src 'none'; sandbox", markupOnly: false },
    { name: "X-Content-Type-Options", value: "nosniff", markupOnly: false },
  ],
};

/** `CARD_EFFECT_CATALOG` in `web/src/features/branding/card-effect-catalog.ts`. */
export const PANEL_CARD_EFFECTS: Readonly<Record<string, PanelCardEffect>> = {
  "aurora": {
    renderer: "webgl1",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 5, default: 1 },
      "amplitude": { min: 0.1, max: 3, default: 1 },
      "blend": { min: 0, max: 1, default: 0.5 },
    },
  },
  "threads": {
    renderer: "webgl1",
    fullOutputGamut: false,
    sliders: {
      "amplitude": { min: 0.1, max: 3, default: 1 },
      "distance": { min: 0, max: 2, default: 0 },
    },
  },
  "softAurora": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 0.1, max: 3, default: 0.6 },
      "scale": { min: 0.5, max: 5, default: 1.5 },
      "brightness": { min: 0.1, max: 3, default: 1 },
      "noiseFrequency": { min: 0.5, max: 10, default: 2.5 },
    },
  },
  "rippleGrid": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "rippleIntensity": { min: 0.01, max: 0.2, default: 0.05 },
      "gridSize": { min: 2, max: 30, default: 10 },
      "glowIntensity": { min: 0, max: 0.5, default: 0.1 },
    },
  },
  "radar": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 0.1, max: 5, default: 1 },
      "ringCount": { min: 3, max: 20, default: 10 },
      "spokeCount": { min: 3, max: 20, default: 10 },
      "sweepSpeed": { min: 0.1, max: 5, default: 1 },
      "brightness": { min: 0.1, max: 3, default: 1 },
    },
  },
  "plasma": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 5, default: 1 },
      "scale": { min: 0.1, max: 5, default: 1 },
    },
  },
  "particles": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "particleCount": { min: 50, max: 500, default: 200 },
      "speed": { min: 0.01, max: 1, default: 0.1 },
      "particleBaseSize": { min: 10, max: 300, default: 100 },
    },
  },
  "liquidChrome": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 0.01, max: 1, default: 0.2 },
      "amplitude": { min: 0.1, max: 2, default: 0.5 },
      "frequencyX": { min: 1, max: 10, default: 3 },
      "frequencyY": { min: 1, max: 10, default: 2 },
    },
  },
  "lineWaves": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 0.05, max: 2, default: 0.3 },
      "brightness": { min: 0.05, max: 1, default: 0.2 },
      "warpIntensity": { min: 0, max: 5, default: 1 },
    },
  },
  "iridescence": {
    renderer: "webgl1",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 5, default: 1 },
      "amplitude": { min: 0.01, max: 1, default: 0.1 },
    },
  },
  "grainient": {
    renderer: "webgl2",
    fullOutputGamut: true,
    sliders: {
      "timeSpeed": { min: 0.05, max: 2, default: 0.25 },
      "grainAmount": { min: 0, max: 0.5, default: 0.1 },
      "warpStrength": { min: 0, max: 5, default: 1 },
      "contrast": { min: 0.5, max: 2.5, default: 1.5 },
    },
  },
  "galaxy": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 0.1, max: 5, default: 1 },
      "density": { min: 0.1, max: 3, default: 1 },
      "hueShift": { min: 0, max: 360, default: 140 },
      "glowIntensity": { min: 0, max: 1, default: 0.3 },
      "twinkleIntensity": { min: 0, max: 1, default: 0.3 },
    },
  },
  "balatro": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "spinSpeed": { min: 0.5, max: 15, default: 7 },
      "contrast": { min: 1, max: 8, default: 3.5 },
      "lighting": { min: 0, max: 1, default: 0.4 },
    },
  },
  "waves": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "waveSpeedX": { min: 0.001, max: 0.05, default: 0.0125 },
      "waveAmpX": { min: 5, max: 100, default: 32 },
      "xGap": { min: 2, max: 30, default: 10 },
      "yGap": { min: 5, max: 60, default: 32 },
    },
  },
  "silk": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 10, default: 5 },
      "scale": { min: 0.1, max: 5, default: 1 },
      "noiseIntensity": { min: 0, max: 5, default: 1.5 },
      "rotation": { min: -180, max: 180, default: 0 },
    },
  },
  "beams": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.5, max: 10, default: 2 },
      "beamWidth": { min: 0.5, max: 5, default: 2 },
      "beamNumber": { min: 4, max: 30, default: 12 },
      "noiseIntensity": { min: 0, max: 5, default: 1.75 },
      "scale": { min: 0.05, max: 1, default: 0.2 },
    },
  },
  "dither": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "waveSpeed": { min: 0.01, max: 0.2, default: 0.05 },
      "waveFrequency": { min: 1, max: 10, default: 3 },
      "waveAmplitude": { min: 0.05, max: 1, default: 0.3 },
      "pixelSize": { min: 1, max: 8, default: 2 },
      "colorNum": { min: 2, max: 8, default: 4 },
    },
  },
  "paperMesh": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 3, default: 1 },
      "distortion": { min: 0, max: 1, default: 0.8 },
      "swirl": { min: 0, max: 1, default: 0.1 },
    },
  },
  "paperWarp": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 5, default: 1 },
      "proportion": { min: 0, max: 1, default: 0.45 },
      "softness": { min: 0, max: 1, default: 1 },
      "distortion": { min: 0, max: 1, default: 0.25 },
      "swirl": { min: 0, max: 1, default: 0.8 },
      "swirlIterations": { min: 1, max: 20, default: 10 },
      "shapeScale": { min: 0, max: 1, default: 0.1 },
    },
  },
  "paperGrain": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 3, default: 1 },
      "softness": { min: 0, max: 1, default: 0.5 },
      "intensity": { min: 0, max: 1, default: 0.5 },
      "noise": { min: 0, max: 1, default: 0.25 },
    },
  },
  "paperDither": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 3, default: 1 },
      "size": { min: 1, max: 12, default: 2 },
      "scale": { min: 0.1, max: 2, default: 0.6 },
    },
  },
  "paperSwirl": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.05, max: 2, default: 0.32 },
      "bandCount": { min: 1, max: 12, default: 4 },
      "twist": { min: 0, max: 1, default: 0.1 },
      "center": { min: 0, max: 1, default: 0.2 },
      "proportion": { min: 0, max: 1, default: 0.5 },
      "softness": { min: 0, max: 1, default: 0 },
      "noiseFrequency": { min: 0, max: 1, default: 0.4 },
      "noise": { min: 0, max: 1, default: 0.2 },
    },
  },
  "paperMetaballs": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 3, default: 1 },
      "count": { min: 1, max: 20, default: 10 },
      "size": { min: 0.1, max: 1, default: 0.83 },
      "scale": { min: 0.5, max: 4, default: 1 },
    },
  },
  "snowfall": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "count": { min: 20, max: 400, default: 160 },
      "speedMin": { min: 0.1, max: 5, default: 0.6 },
      "speedMax": { min: 0.1, max: 5, default: 2.4 },
      "wind": { min: -3, max: 3, default: 0 },
      "windVariation": { min: 0, max: 3, default: 0.8 },
      "sizeMin": { min: 0.5, max: 6, default: 1 },
      "sizeMax": { min: 0.5, max: 6, default: 4 },
      "opacityMin": { min: 5, max: 100, default: 30 },
      "opacityMax": { min: 5, max: 100, default: 90 },
    },
  },
  "stardust": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "particleDensity": { min: 1, max: 8, default: 4 },
      "minSize": { min: 0.5, max: 5, default: 1.5 },
      "maxSize": { min: 0.5, max: 5, default: 1 },
      "speed": { min: 1, max: 10, default: 10 },
      "particleSpeed": { min: 0, max: 10, default: 1 },
      "movement": { min: 0, max: 10, default: 6 },
      "angle": { min: 0, max: 360, default: 180 },
    },
  },
  "asciiRain": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "glyphSize": { min: 8, max: 40, default: 20 },
      "speed": { min: 1, max: 20, default: 6 },
      "angle": { min: -90, max: 90, default: 0 },
      "density": { min: 5, max: 55, default: 50 },
      "trail": { min: 3, max: 40, default: 23 },
    },
  },
  "asciiFlame": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "intensity": { min: 10, max: 100, default: 100 },
      "decay": { min: 5, max: 40, default: 13 },
      "turbulence": { min: 0, max: 100, default: 30 },
      "thickness": { min: 1, max: 8, default: 1 },
      "windForce": { min: 10, max: 100, default: 10 },
    },
  },
  "characterWaves": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "elementSize": { min: 12, max: 48, default: 16 },
      "speed": { min: 5, max: 100, default: 20 },
      "waveTension": { min: 1, max: 20, default: 5 },
      "noiseScale": { min: 1, max: 50, default: 12 },
      "intensity": { min: 1, max: 30, default: 10 },
      "interactionIntensity": { min: 0, max: 50, default: 15 },
      "interactionRadius": { min: 40, max: 400, default: 160 },
    },
  },
  "blinkingSquares": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "gridSize": { min: 8, max: 60, default: 40 },
      "fillPercent": { min: 10, max: 100, default: 70 },
      "twinkleSpeed": { min: 1, max: 100, default: 30 },
      "opacity": { min: 0.1, max: 1, default: 1 },
      "fadePercent": { min: 0, max: 100, default: 100 },
      "fadeIntensity": { min: 0, max: 100, default: 25 },
      "cursorRadius": { min: 40, max: 400, default: 140 },
      "cursorBoost": { min: 5, max: 100, default: 60 },
    },
  },
  "lineRipple": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "count": { min: 10, max: 80, default: 57 },
      "movement": { min: 2, max: 100, default: 24 },
      "resolution": { min: 1, max: 25, default: 10 },
      "force": { min: 0, max: 10, default: 4 },
    },
  },
  "pulseLines": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "cornerRadius": { min: 0, max: 6, default: 0 },
      "paletteCount": { min: 1, max: 5, default: 1 },
      "speed": { min: 0, max: 200, default: 99 },
      "lineWidth": { min: 1, max: 12, default: 2 },
      "gap": { min: 8, max: 100, default: 30 },
      "scale": { min: 0.5, max: 6, default: 2.5 },
    },
  },
  "textWave": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "paletteCount": { min: 1, max: 5, default: 1 },
      "fontWeight": { min: 100, max: 900, default: 400 },
      "fontSize": { min: 10, max: 48, default: 14 },
      "letterSpacing": { min: -2, max: 8, default: 0 },
      "speed": { min: 5, max: 200, default: 61 },
      "gap": { min: 8, max: 40, default: 10 },
    },
  },
  "pixelCard": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "gap": { min: 5, max: 24, default: 6 },
      "pixelSize": { min: 1, max: 10, default: 2 },
      "speed": { min: 5, max: 100, default: 80 },
      "padding": { min: 0, max: 32, default: 0 },
      "borderWidth": { min: 0, max: 8, default: 1 },
      "radius": { min: 0, max: 48, default: 25 },
    },
  },
  "glitterWrap": {
    renderer: "canvas2d",
    fullOutputGamut: true,
    sliders: {
      "particleCount": { min: 100, max: 700, default: 500 },
      "speed": { min: 1, max: 15, default: 5 },
      "density": { min: 10, max: 100, default: 100 },
      "starSize": { min: 2, max: 20, default: 20 },
      "focalDepth": { min: 2, max: 30, default: 8 },
      "turbulence": { min: 0, max: 10, default: 0 },
      "brightness": { min: 10, max: 100, default: 100 },
      "glitterIntensity": { min: 0, max: 10, default: 3 },
      "trailAmount": { min: 0, max: 100, default: 0 },
    },
  },
  "chromaticWaves": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "frequency": { min: 1, max: 10, default: 1 },
      "speed": { min: 0.5, max: 20, default: 4 },
      "cellSize": { min: 1, max: 100, default: 34 },
      "gamma": { min: 1, max: 20, default: 6 },
      "paletteBias": { min: -10, max: 10, default: -3 },
    },
  },
  "dotMatrix": {
    renderer: "webgl2",
    fullOutputGamut: false,
    sliders: {
      "frequency": { min: 1, max: 10, default: 1 },
      "speed": { min: 0.5, max: 20, default: 6 },
      "cellSize": { min: 1, max: 100, default: 20 },
      "gamma": { min: 1, max: 20, default: 4 },
      "paletteBias": { min: -10, max: 10, default: 10 },
      "fontWeight": { min: 100, max: 900, default: 400 },
      "fontSizePx": { min: 16, max: 96, default: 42 },
    },
  },
  "pixelTetris": {
    renderer: "canvas2d",
    fullOutputGamut: true,
    sliders: {
      "movement": { min: 0, max: 10, default: 4 },
      "cellSize": { min: 10, max: 48, default: 29 },
      "gap": { min: 0, max: 6, default: 1 },
      "rounded": { min: 0, max: 20, default: 20 },
      "dropSpeed": { min: 0.5, max: 6, default: 2 },
    },
  },
  "risingLines": {
    renderer: "canvas2d",
    fullOutputGamut: true,
    sliders: {
      "particles": { min: 50, max: 1500, default: 500 },
      "riseSpeed": { min: 0, max: 60, default: 25 },
      "opacity": { min: 10, max: 100, default: 100 },
      "scale": { min: 1, max: 12, default: 7 },
      "horizonOpacity": { min: 0, max: 100, default: 85 },
    },
  },
  "starBurst": {
    renderer: "canvas2d",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 1, max: 40, default: 10 },
      "starCount": { min: 20, max: 180, default: 100 },
      "centerX": { min: 0, max: 100, default: 50 },
      "centerY": { min: 0, max: 100, default: 100 },
      "starSize": { min: 2, max: 40, default: 12 },
      "opacity": { min: 5, max: 100, default: 50 },
      "flowerIntensity": { min: 0, max: 40, default: 10 },
      "twinkleSpeed": { min: 0, max: 20, default: 4 },
    },
  },
  "particleTunnel": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "x": { min: 0, max: 100, default: 50 },
      "y": { min: 0, max: 100, default: 50 },
      "radius": { min: 0, max: 60, default: 10 },
      "density": { min: 4, max: 60, default: 30 },
      "gap": { min: 20, max: 160, default: 40 },
      "particleSize": { min: 1, max: 12, default: 4 },
      "speed": { min: 0.5, max: 12, default: 2 },
    },
  },
  "floatingIcons": {
    renderer: "canvas2d",
    fullOutputGamut: true,
    sliders: {
      "amount": { min: 5, max: 80, default: 30 },
      "minSpeed": { min: 1, max: 50, default: 20 },
      "maxSpeed": { min: 1, max: 50, default: 23 },
      "minShake": { min: 0, max: 100, default: 32 },
      "maxShake": { min: 0, max: 100, default: 0 },
      "coverage": { min: 20, max: 150, default: 100 },
      "minSize": { min: 2, max: 40, default: 4 },
      "maxSize": { min: 8, max: 80, default: 54 },
    },
  },
  "snakeGrid": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "cellSize": { min: 16, max: 56, default: 42 },
      "gap": { min: 0, max: 6, default: 1 },
      "rounded": { min: 0, max: 20, default: 0 },
      "speed": { min: 2, max: 24, default: 10 },
      "startLength": { min: 1, max: 12, default: 1 },
      "growth": { min: 1, max: 6, default: 1 },
      "fade": { min: 0, max: 100, default: 32 },
    },
  },
  "gridHole": {
    renderer: "canvas2d",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 10, max: 150, default: 50 },
      "lineWidth": { min: 0.5, max: 5, default: 1 },
      "lines": { min: 8, max: 120, default: 80 },
      "discs": { min: 10, max: 120, default: 80 },
      "particleCount": { min: 50, max: 500, default: 300 },
    },
  },
  "waveArcs": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "lineWidth": { min: 0.5, max: 5, default: 1.5 },
      "lineCount": { min: 12, max: 100, default: 76 },
      "speed": { min: 1, max: 30, default: 6 },
      "glow": { min: 4, max: 50, default: 10 },
    },
  },
  "reactiveGrid": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "strokeWidth": { min: 0.5, max: 6, default: 1.5 },
      "maxSize": { min: 16, max: 64, default: 36 },
      "minSize": { min: 2, max: 30, default: 12 },
      "gap": { min: 0, max: 24, default: 4 },
      "influence": { min: 40, max: 400, default: 120 },
    },
  },
  "reactiveLines": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "lineWidth": { min: 0.5, max: 6, default: 1 },
      "minLines": { min: 1, max: 40, default: 2 },
      "maxLines": { min: 5, max: 70, default: 45 },
      "fadeIntensity": { min: 1, max: 50, default: 15 },
    },
  },
  "prismGrid": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "boxSize": { min: 28, max: 90, default: 40 },
      "borderWidth": { min: 0, max: 5, default: 2 },
    },
  },
  "thunderstrike": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "xOffset": { min: -30, max: 30, default: 11 },
      "speed": { min: 10, max: 110, default: 55 },
      "intensity": { min: 20, max: 120, default: 69 },
      "size": { min: 5, max: 60, default: 20 },
      "angle": { min: -90, max: 90, default: 10 },
    },
  },
  "blackhole": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "particleCount": { min: 60, max: 600, default: 260 },
      "particleSize": { min: 1, max: 50, default: 4 },
      "orbitSpeed": { min: 0.5, max: 15, default: 4 },
      "trail": { min: 0, max: 50, default: 50 },
      "tilt": { min: -90, max: 90, default: 20 },
      "voidRadius": { min: 10, max: 100, default: 40 },
      "outerRadius": { min: 20, max: 100, default: 70 },
      "pullSpeed": { min: 0, max: 20, default: 0 },
    },
  },
  "cosmicOrb": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "zoom": { min: 0.5, max: 3, default: 1 },
      "speed": { min: 5, max: 150, default: 50 },
      "spin": { min: 0, max: 150, default: 50 },
      "lensAmount": { min: 0, max: 100, default: 45 },
      "seed": { min: 0, max: 100, default: 17 },
    },
  },
  "tornado": {
    renderer: "webgl2",
    fullOutputGamut: true,
    sliders: {
      "lineCount": { min: 20, max: 200, default: 120 },
      "lineGlow": { min: 0, max: 10, default: 10 },
      "twist": { min: 0, max: 10, default: 3 },
      "zoom": { min: 40, max: 110, default: 75 },
      "speed": { min: 2, max: 40, default: 10 },
      "dotCount": { min: 250, max: 3000, default: 2000 },
    },
  },
  "cube": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "cubeGrid": { min: 2, max: 5, default: 3 },
      "dotsPerFace": { min: 2, max: 5, default: 5 },
      "dotSize": { min: 1, max: 6, default: 2 },
      "rotationX": { min: -12, max: 12, default: 0 },
      "rotationY": { min: -12, max: 12, default: 11 },
      "rotationZ": { min: -12, max: 12, default: 0 },
      "sizePercent": { min: 20, max: 200, default: 100 },
    },
  },
  "wordGlobe": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "fontSize": { min: 8, max: 40, default: 15 },
      "fontWeight": { min: 100, max: 900, default: 500 },
      "speed": { min: 1, max: 30, default: 7 },
      "twist": { min: 0, max: 100, default: 50 },
      "letterSpacing": { min: 200, max: 2000, default: 800 },
    },
  },
  "particleSphere": {
    renderer: "webgl2",
    fullOutputGamut: true,
    sliders: {
      "particlesCount": { min: 500, max: 4000, default: 2500 },
      "particleScale": { min: 1, max: 10, default: 8 },
      "scale": { min: 2, max: 10, default: 10 },
      "speed": { min: 5, max: 60, default: 20 },
      "cursorRadius": { min: 20, max: 200, default: 75 },
      "cursorStrength": { min: 0, max: 10, default: 10 },
    },
  },
  "colorBends": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 0.02, max: 2, default: 0.2 },
      "rotation": { min: 0, max: 360, default: 90 },
      "autoRotate": { min: -2, max: 2, default: 0 },
      "scale": { min: 0.2, max: 4, default: 1 },
      "frequency": { min: 0.2, max: 4, default: 1 },
      "warpStrength": { min: 0, max: 3, default: 1 },
      "bandWidth": { min: 1, max: 20, default: 6 },
      "intensity": { min: 0.1, max: 3, default: 1.5 },
      "noise": { min: 0, max: 0.5, default: 0.15 },
      "iterations": { min: 1, max: 5, default: 1 },
      "parallax": { min: 0, max: 2, default: 0.5 },
      "mouseInfluence": { min: 0, max: 2, default: 1 },
    },
  },
  "pixelBlast": {
    renderer: "webgl2",
    fullOutputGamut: true,
    sliders: {
      "pixelSize": { min: 1, max: 12, default: 3 },
      "speed": { min: 0.05, max: 3, default: 0.5 },
      "patternScale": { min: 0.5, max: 6, default: 2 },
      "patternDensity": { min: 0.1, max: 3, default: 1 },
      "pixelSizeJitter": { min: 0, max: 1, default: 0 },
      "edgeFade": { min: 0, max: 1, default: 0.5 },
      "noiseAmount": { min: 0, max: 0.5, default: 0 },
      "rippleSpeed": { min: 0.05, max: 2, default: 0.3 },
      "rippleThickness": { min: 0.01, max: 0.5, default: 0.1 },
      "rippleIntensityScale": { min: 0, max: 3, default: 1 },
      "liquidStrength": { min: 0, max: 1, default: 0.1 },
      "liquidRadius": { min: 0.1, max: 3, default: 1 },
      "liquidWobbleSpeed": { min: 0.5, max: 10, default: 4.5 },
    },
  },
  "plasmaWave": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed1": { min: 0.005, max: 0.5, default: 0.05 },
      "speed2": { min: 0.005, max: 0.5, default: 0.05 },
      "dir2": { min: -1, max: 1, default: 1 },
      "bend1": { min: 0, max: 3, default: 1 },
      "bend2": { min: 0, max: 3, default: 0.5 },
      "focalLength": { min: 0.2, max: 3, default: 0.8 },
      "rotationDeg": { min: -180, max: 180, default: 0 },
      "xOffset": { min: -500, max: 500, default: 0 },
      "yOffset": { min: -500, max: 500, default: 0 },
    },
  },
  "evilEye": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "intensity": { min: 0.1, max: 4, default: 1.5 },
      "flameSpeed": { min: 0.05, max: 4, default: 1 },
      "pupilSize": { min: 0.1, max: 1.5, default: 0.6 },
      "irisWidth": { min: 0.05, max: 1, default: 0.25 },
      "glowIntensity": { min: 0, max: 1.5, default: 0.35 },
      "scale": { min: 0.2, max: 2, default: 0.8 },
      "noiseScale": { min: 0.2, max: 4, default: 1 },
      "pupilFollow": { min: 0, max: 2, default: 1 },
    },
  },
  "lightPillar": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "intensity": { min: 0.1, max: 3, default: 1 },
      "rotationSpeed": { min: 0.02, max: 2, default: 0.3 },
      "glowAmount": { min: 0.001, max: 0.05, default: 0.005 },
      "pillarWidth": { min: 0.5, max: 10, default: 3 },
      "pillarHeight": { min: 0.1, max: 2, default: 0.4 },
      "pillarRotation": { min: -180, max: 180, default: 0 },
      "noiseIntensity": { min: 0, max: 2, default: 0.5 },
    },
  },
  "prismaticBurst": {
    renderer: "webgl2",
    fullOutputGamut: true,
    sliders: {
      "intensity": { min: 0.1, max: 5, default: 2 },
      "speed": { min: 0.05, max: 3, default: 0.5 },
      "distort": { min: 0, max: 10, default: 0 },
      "rayCount": { min: 0, max: 32, default: 0 },
      "hoverDampness": { min: 0, max: 1, default: 0 },
    },
  },
  "faultyTerminal": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "brightness": { min: 0.1, max: 3, default: 1 },
      "timeScale": { min: 0.05, max: 3, default: 0.3 },
      "scale": { min: 0.5, max: 5, default: 1 },
      "digitSize": { min: 0.5, max: 4, default: 1.5 },
      "scanlineIntensity": { min: 0, max: 2, default: 0.3 },
      "glitchAmount": { min: 0, max: 5, default: 1 },
      "flickerAmount": { min: 0, max: 5, default: 1 },
      "noiseAmp": { min: 0, max: 3, default: 1 },
      "chromaticAberration": { min: 0, max: 10, default: 0 },
      "dither": { min: 0, max: 5, default: 0 },
      "curvature": { min: 0, max: 1, default: 0.2 },
      "mouseStrength": { min: 0, max: 2, default: 0.2 },
    },
  },
  "letterGlitch": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "glitchSpeed": { min: 10, max: 500, default: 50 },
    },
  },
  "shapeGrid": {
    renderer: "canvas2d",
    fullOutputGamut: false,
    sliders: {
      "speed": { min: 0.1, max: 5, default: 1 },
      "squareSize": { min: 10, max: 120, default: 40 },
      "hoverTrailAmount": { min: 0, max: 20, default: 0 },
      "vignetteStrength": { min: 0, max: 1, default: 1 },
    },
  },
  "magicRings": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "speed": { min: 0.05, max: 3, default: 1 },
      "ringCount": { min: 1, max: 10, default: 6 },
      "opacity": { min: 0.05, max: 1, default: 1 },
      "attenuation": { min: 1, max: 30, default: 10 },
      "lineThickness": { min: 0.5, max: 10, default: 2 },
      "baseRadius": { min: 0.05, max: 1, default: 0.35 },
      "radiusStep": { min: 0, max: 0.5, default: 0.1 },
      "scaleRate": { min: 0, max: 1, default: 0.1 },
      "ringGap": { min: 0.5, max: 4, default: 1.5 },
      "rotation": { min: -180, max: 180, default: 0 },
      "noiseAmount": { min: 0, max: 1, default: 0.1 },
      "fadeIn": { min: 0.05, max: 2, default: 0.7 },
      "fadeOut": { min: 0.05, max: 3, default: 0.5 },
      "parallax": { min: 0, max: 1, default: 0.05 },
      "mouseInfluence": { min: 0, max: 1, default: 0.2 },
    },
  },
  "laserFlow": {
    renderer: "webgl1",
    fullOutputGamut: true,
    sliders: {
      "flowSpeed": { min: 0.02, max: 2, default: 0.35 },
      "decay": { min: 0.2, max: 4, default: 1.1 },
      "falloffStart": { min: 0.2, max: 4, default: 1.2 },
      "verticalSizing": { min: 0.2, max: 6, default: 2 },
      "horizontalSizing": { min: 0.1, max: 3, default: 0.5 },
      "horizontalBeamOffset": { min: -1, max: 1, default: 0.1 },
      "verticalBeamOffset": { min: -1, max: 1, default: 0 },
      "fogIntensity": { min: 0, max: 2, default: 0.45 },
      "fogScale": { min: 0.05, max: 2, default: 0.3 },
      "fogFallSpeed": { min: 0.05, max: 3, default: 0.6 },
      "wispDensity": { min: 0.1, max: 2, default: 1 },
      "wispSpeed": { min: 0.5, max: 40, default: 15 },
      "wispIntensity": { min: 0, max: 15, default: 5 },
      "flowStrength": { min: 0, max: 1, default: 0.25 },
      "mouseTiltStrength": { min: 0, max: 0.2, default: 0.01 },
    },
  },
  "antigravity": {
    renderer: "webgl1",
    fullOutputGamut: false,
    sliders: {
      "count": { min: 20, max: 800, default: 300 },
      "particleSize": { min: 0.2, max: 8, default: 2 },
      "lerpSpeed": { min: 0.02, max: 1, default: 0.1 },
      "ringRadius": { min: 2, max: 30, default: 10 },
      "magnetRadius": { min: 2, max: 40, default: 10 },
      "fieldStrength": { min: 0.5, max: 30, default: 10 },
      "waveAmplitude": { min: 0, max: 5, default: 1 },
      "waveSpeed": { min: 0.05, max: 3, default: 0.4 },
      "rotationSpeed": { min: 0.02, max: 2, default: 0.1 },
      "pulseSpeed": { min: 0.1, max: 10, default: 3 },
      "particleVariance": { min: 0, max: 3, default: 1 },
      "depthFactor": { min: 0, max: 3, default: 1 },
    },
  },
};

/** The closed branding vocabularies, from the interface, the DTO and the form schema. */
export const PANEL_BRANDING_VOCABULARY: PanelBrandingVocabulary = {
  vocabularies: {
    "bgEffects": [
      "NONE",
      "MESH",
      "PARTICLES",
      "NOISE",
      "AURORA",
    ],
    "appBackgroundKinds": [
      "none",
      "plain",
      "gradient",
      "texture",
      "effect",
    ],
    "appBackgroundTextures": [
      "dots",
      "grid",
      "diagonal",
      "cross",
      "waves",
      "carbon",
      "triangles",
      "noise",
    ],
    "iconColorModes": [
      "default",
      "theme",
      "custom",
    ],
    "subscriptionCardTextModes": [
      "auto",
      "light",
      "dark",
      "custom",
    ],
    "planCardTextModes": [
      "inherit",
      "auto",
      "light",
      "dark",
      "custom",
    ],
    "cardEffectSlotModes": [
      "inherit",
      "override",
    ],
    "cardLogoPresets": [
      "DEFAULT",
      "NONE",
      "SHIELD",
      "BOLT",
      "GLOBE",
      "ROCKET",
      "GHOST",
      "CROWN",
      "GEM",
      "FLAME",
      "WAVES",
      "MOUNTAIN",
      "ORBIT",
      "HEXAGON",
    ],
    "brandLogoFrames": [
      "glass",
      "solid",
      "outline",
      "none",
    ],
    "navDestinations": [
      "subscriptions",
      "plans",
      "referrals",
      "devices",
      "activity",
      "promo",
      "support",
      "faq",
      "settings",
    ],
    "navEssentials": [
      "subscriptions",
      "settings",
    ],
    "brandPaletteSources": [
      "concept",
      "custom",
    ],
    "cardGradientSources": [
      "concept",
      "custom",
    ],
    "borderRadiusClasses": [
      "rounded-none",
      "rounded-lg",
      "rounded-xl",
      "rounded-2xl",
      "rounded-3xl",
      "rounded-full",
    ],
    "formBgEffects": [
      "NONE",
      "MESH",
      "PARTICLES",
      "NOISE",
      "AURORA",
    ],
    "formIconColorModes": [
      "default",
      "theme",
      "custom",
    ],
    "formSubscriptionCardTextModes": [
      "auto",
      "light",
      "dark",
      "custom",
    ],
    "formPlanCardTextModes": [
      "inherit",
      "auto",
      "light",
      "dark",
      "custom",
    ],
    "formAppBackgroundKinds": [
      "none",
      "plain",
      "gradient",
      "texture",
      "effect",
    ],
    "formAppBackgroundTextures": [
      "dots",
      "grid",
      "diagonal",
      "cross",
      "waves",
      "carbon",
      "triangles",
      "noise",
    ],
    "formNavDestinations": [
      "subscriptions",
      "plans",
      "referrals",
      "devices",
      "activity",
      "promo",
      "support",
      "faq",
      "settings",
    ],
    "formBorderRadiusClasses": [
      "rounded-none",
      "rounded-lg",
      "rounded-xl",
      "rounded-2xl",
      "rounded-3xl",
      "rounded-full",
    ],
  },
  navMaxVisible: 5,
  dtoBorderRadius: { declarations: 2, validators: 2 },
  dtoIsInVocabularies: [
    ["dark", "light"],
    ["fixed", "user-selectable"],
  ],
};
