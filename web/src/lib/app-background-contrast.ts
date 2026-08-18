import type { Branding } from "@/types/branding";

const WHITE_RGB: Rgb = [255, 255, 255];
const BLACK_RGB: Rgb = [0, 0, 0];
const MINIMUM_TEXT_CONTRAST = 4.5;
const VEIL_SAFETY_MARGIN = 0.03;
const MAX_VEIL_OPACITY = 0.88;

type Rgb = readonly [number, number, number];

interface Rgba {
  readonly rgb: Rgb;
  readonly alpha: number;
}

export interface AppBackgroundReadability {
  readonly veilRgb: string;
  readonly veilOpacity: number;
  readonly overlayBackground: string;
}

export function resolveAppBackgroundReadability(
  branding: Pick<Branding, "appBackground" | "bgPrimary" | "surfaceTheme" | "themePresetId">,
): AppBackgroundReadability | null {
  const appBackground = branding.appBackground;
  const foreground = parseCssColor(branding.surfaceTheme?.foreground ?? "");
  const mutedForeground = parseCssColor(branding.surfaceTheme?.mutedForeground ?? "");
  if (
    !appBackground ||
    !foreground ||
    !mutedForeground ||
    appBackground.kind === "none" ||
    appBackground.kind === "plain" ||
    appBackground.kind === "effect"
  ) {
    return null;
  }

  const samples = resolveBackgroundSamples(branding);
  if (samples.length === 0) return null;

  const textColors = [foreground.rgb, mutedForeground.rgb] as const;
  const candidates = [
    resolveVeilCandidate(samples, textColors, BLACK_RGB),
    resolveVeilCandidate(samples, textColors, WHITE_RGB),
  ].filter((candidate): candidate is VeilCandidate => candidate !== null);
  if (candidates.length === 0) return null;

  candidates.sort((left, right) => left.rawOpacity - right.rawOpacity);
  const chosen = candidates[0]!;
  const channels = rgbChannels(chosen.veilRgb);

  /**
   * ONE opacity, edge to edge — a flat colour, not a gradient.
   *
   * This used to return `linear-gradient(180deg, edge 0%, veil 16% … 84%, edge
   * 100%)` with `edge = veilOpacity + 0.12`, on a layer that is
   * `absolute inset-0` over the whole `100dvh` shell. The bottom ramp therefore
   * painted the bottom 16% of the VIEWPORT — about 130px on a phone — darker
   * (or, on a white veil, lighter) than the rest of the page, full-bleed across
   * it. That is exactly where the floating bottom-nav pill sits, and the pill is
   * `w-fit`, so the ramp read as a skirt around it that stuck out to its left
   * and right. It showed on 101 of the 104 concept presets, because every one of
   * them ships `appBackground.kind === "gradient"` and so reaches this resolver,
   * and the panel's branding preview reproduced it faithfully by rendering this
   * same string.
   *
   * Removing it costs no readability. AA is carried ENTIRELY by
   * `chosen.veilOpacity`: `resolveVeilCandidate` returns a candidate only when
   * `supportsContrast` clears 4.5:1 for both text colours against every painted
   * sample at that opacity, so the flat middle of the old gradient already WAS
   * the guarantee and the two end stops were decorative headroom above it. It is
   * also what the guards measure — `app-background-contrast.test.ts` asserts
   * against `weakestZoneOpacity()`, the smallest alpha appearing in this value,
   * and the panel's `theme-presets.test.ts` asserts against `veilOpacity`
   * itself. Both keep reading the same number they read before.
   *
   * Keep this a single colour. Any position-dependent alpha here puts a band
   * back under the navigation, and this layer has no way to know where the
   * navigation is.
   */
  return {
    veilRgb: channels,
    veilOpacity: chosen.veilOpacity,
    overlayBackground: `rgb(${channels} / ${chosen.veilOpacity})`,
  };
}

interface VeilCandidate {
  readonly veilRgb: Rgb;
  readonly rawOpacity: number;
  readonly veilOpacity: number;
}

/**
 * Every colour the app background can put under the direct copy, INCLUDING the
 * cross-position blends of the textured product that the veil maths below no
 * longer enumerates. Nothing in the app calls this — it is the specification
 * the readability guard asserts against, kept here rather than re-derived in a
 * test so that the two cannot drift apart.
 *
 * See `resolveSoftLightTextureSamples` for what the extra blends are and why
 * choosing the veil stopped walking them.
 */
export function resolveAppBackgroundPaintedSamples(
  branding: Pick<Branding, "appBackground" | "bgPrimary" | "themePresetId">,
): readonly Rgb[] {
  return resolveBackgroundSamples(branding, true);
}

function resolveBackgroundSamples(
  branding: Pick<Branding, "appBackground" | "bgPrimary" | "themePresetId">,
  includeCrossPositionBlends = false,
): Rgb[] {
  const appBackground = branding.appBackground;
  if (!appBackground) return [];
  const texture = appBackground.texture;

  const fallback =
    parseCssColor(appBackground.kind === "texture" ? texture?.background ?? branding.bgPrimary : branding.bgPrimary)?.rgb ??
    null;

  if (appBackground.kind === "none" || appBackground.kind === "plain") return [];
  if (appBackground.kind === "texture") {
    const textureBackground = parseCssColor(appBackground.texture.background)?.rgb;
    const textureColor = parseCssColor(appBackground.texture.color)?.rgb;
    if (!textureBackground) return [];
    return textureColor
      ? uniqueRgb([
          textureBackground,
          compositeRgb(
            textureColor,
            textureBackground,
            clamp(appBackground.texture.opacity, 0, 1),
          ),
        ])
      : [textureBackground];
  }

  const gradientSamples = resolveGradientSamples(
    extractCssColors(appBackground.gradient),
    fallback,
  );
  const samples = [...gradientSamples];

  const includeConceptTexture =
    appBackground.kind === "gradient" &&
    typeof branding.themePresetId === "string" &&
    branding.themePresetId.startsWith("concept-") &&
    texture !== undefined;
  if (includeConceptTexture) {
    const textureColor = parseCssColor(texture.color)?.rgb;
    if (textureColor) {
      samples.push(
        ...resolveSoftLightTextureSamples(
          gradientSamples,
          textureColor,
          clamp(texture.opacity, 0, 1),
          includeCrossPositionBlends,
        ),
      );
    }
  }

  return uniqueRgb(samples);
}

function requiredVeilOpacity(
  samples: readonly Rgb[],
  textColors: readonly Rgb[],
  veil: Rgb,
): number {
  let required = 0;
  for (const sample of samples) {
    for (const textColor of textColors) {
      if (contrastRatio(textColor, sample) >= MINIMUM_TEXT_CONTRAST) continue;
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < 18; iteration += 1) {
        const midpoint = (low + high) / 2;
        const supported = compositeRgb(veil, sample, midpoint);
        if (contrastRatio(textColor, supported) >= MINIMUM_TEXT_CONTRAST) {
          high = midpoint;
        } else {
          low = midpoint;
        }
      }
      required = Math.max(required, high);
    }
  }
  return required;
}

function resolveVeilCandidate(
  samples: readonly Rgb[],
  textColors: readonly Rgb[],
  veilRgb: Rgb,
): VeilCandidate | null {
  const rawOpacity = requiredVeilOpacity(samples, textColors, veilRgb);
  if (rawOpacity <= 0) return null;
  const veilOpacity = roundOpacity(
    clamp(rawOpacity + VEIL_SAFETY_MARGIN, 0, MAX_VEIL_OPACITY),
  );
  if (!supportsContrast(samples, textColors, veilRgb, veilOpacity)) {
    return null;
  }
  return { veilRgb, rawOpacity, veilOpacity };
}

function supportsContrast(
  samples: readonly Rgb[],
  textColors: readonly Rgb[],
  veilRgb: Rgb,
  veilOpacity: number,
): boolean {
  for (const sample of samples) {
    const supported = compositeRgb(veilRgb, sample, veilOpacity);
    for (const textColor of textColors) {
      if (contrastRatio(textColor, supported) < MINIMUM_TEXT_CONTRAST) {
        return false;
      }
    }
  }
  return true;
}

function uniqueRgb(samples: readonly Rgb[]): Rgb[] {
  const seen = new Set<string>();
  const unique: Rgb[] = [];
  for (const sample of samples) {
    const key = sample.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sample);
  }
  return unique;
}

function resolveGradientSamples(
  samples: readonly Rgba[],
  fallback: Rgb | null,
): Rgb[] {
  const opaqueBackdrops = uniqueRgb([
    ...samples
      .filter((sample) => sample.alpha >= 1)
      .map((sample) => sample.rgb),
    ...(fallback ? [fallback] : []),
  ]);
  const backdrops = opaqueBackdrops.length > 0 ? opaqueBackdrops : fallback ? [fallback] : [];
  const translucent = samples.filter((sample) => sample.alpha < 1);
  const resolved = samples.flatMap((sample) => {
    if (sample.alpha >= 1) return [sample.rgb];
    return backdrops.map((backdrop) =>
      compositeRgb(sample.rgb, backdrop, sample.alpha),
    );
  });
  const stacked = backdrops.flatMap((backdrop) =>
    translucent.flatMap((lower) => {
      const lowerComposite = compositeRgb(lower.rgb, backdrop, lower.alpha);
      return translucent.map((upper) =>
        compositeRgb(upper.rgb, lowerComposite, upper.alpha),
      );
    }),
  );
  return uniqueRgb([
    ...resolved,
    ...stacked,
    ...interpolateRgbStates(resolved),
    ...interpolateRgbStates(stacked),
  ]);
}

/**
 * The gradient seen through the concept's soft-light texture, at four strengths
 * up to its configured opacity.
 *
 * `includeCrossPositionBlends` adds the 25/50/75% blends BETWEEN those textured
 * colours. Choosing the veil does not ask for them, and that is deliberate: a
 * blend of the textured colour at one point of the gradient with the textured
 * colour at another is not a colour the browser paints anywhere — every pixel
 * carries one gradient colour under one texture alpha — and `baseSamples`
 * already carries the gradient's own interpolation, so the textured colours at
 * every position in between are present already.
 *
 * Enumerating them anyway cost 40x the whole resolver: 108,187,317 pair blends
 * on `concept-cu` against 3,483 without. Dropping them moved 12 of the 104
 * concept presets, every one DOWNWARD and by at most 0.008 of veil opacity, and
 * every one still clears AA against the full model above — which is what
 * `keeps every concept preset's veil AA-safe against the full painted
 * background` in the panel's `theme-presets.test.ts` exists to keep true.
 */
function resolveSoftLightTextureSamples(
  baseSamples: readonly Rgb[],
  textureColor: Rgb,
  opacity: number,
  includeCrossPositionBlends: boolean,
): Rgb[] {
  if (opacity <= 0) return [];
  const alphaStates = [0.25, 0.5, 0.75, 1]
    .map((step) => roundOpacity(clamp(opacity * step, 0, 1)))
    .filter((alpha, index, values) => alpha > 0 && values.indexOf(alpha) === index);
  const textured = baseSamples.flatMap((base) =>
    alphaStates.map((alpha) =>
      compositeRgb(
        softLightBlend(textureColor, base),
        base,
        alpha,
      ),
    ),
  );
  if (!includeCrossPositionBlends) return uniqueRgb(textured);
  return uniqueRgb([
    ...textured,
    // Interpolate the DEDUPED product. `textured` repeats a colour whenever two
    // gradient samples land on the same value under the same alpha state, and
    // the blends of a deduped set are the same set: a pair of equal samples
    // blends to itself, and that value is already in `textured` above. Same
    // colours, a third fewer pairs — 169,670,790 down to 108,187,317 on
    // `concept-cu`.
    ...interpolateRgbStates(uniqueRgb(textured)),
  ]);
}

/**
 * The 25/50/75% blends between every pair of samples — the colours the browser
 * paints BETWEEN two stops, which a stop-only reading never sees.
 *
 * The dedupe happens DURING generation, not after. Collecting every blend into
 * one array and calling `uniqueRgb` at the end is quadratic in memory as well
 * as in time, and the duplicate ratio is brutal: for the `concept-cu` preset
 * this loop pushed 169,670,790 three-element arrays so that the texture stage
 * could keep the 67,418 distinct colours it actually yields. That did not
 * merely stall a phone — the array never finished being built. On a default
 * heap the process died on "Ineffective mark-compacts near heap limit"; given
 * 12 GB it got further and threw `RangeError: Invalid array length` out of
 * `Array.push`. Either way `resolveAppBackgroundReadability` never returned, so
 * the cabinet's app background failed outright on that preset rather than being
 * slow on it.
 *
 * Skipping a blend already seen bounds the array to the distinct colours.
 * `uniqueRgb` keeps the FIRST occurrence of each colour and so does this,
 * walking the pairs in the same order, so the array returned is unchanged —
 * this is a memory fix, not a change of answer.
 */
function interpolateRgbStates(samples: readonly Rgb[]): Rgb[] {
  const blended: Rgb[] = [];
  // One bit per 24-bit colour: 2 MB flat, and worth it over a Set keyed on the
  // same packed colour, which was measurably the bottleneck once the array was
  // gone (`concept-cu`: 16.7 s with the Set, 4.2 s with the bitmap).
  const seen = new Uint8Array(1 << 21);
  const count = samples.length;
  for (let left = 0; left < count; left += 1) {
    const lower = samples[left]!;
    for (let right = left + 1; right < count; right += 1) {
      const upper = samples[right]!;
      // step/4 is exactly 0.25, 0.5, 0.75, in that order.
      for (let step = 1; step < 4; step += 1) {
        const alpha = step / 4;
        const red = mixChannel(lower[0], upper[0], alpha);
        const green = mixChannel(lower[1], upper[1], alpha);
        const blue = mixChannel(lower[2], upper[2], alpha);
        const key = (red << 16) | (green << 8) | blue;
        const slot = key >> 3;
        const mask = 1 << (key & 7);
        if ((seen[slot]! & mask) !== 0) continue;
        seen[slot] = seen[slot]! | mask;
        blended.push([red, green, blue]);
      }
    }
  }
  return blended;
}

function softLightBlend(source: Rgb, backdrop: Rgb): Rgb {
  return [
    softLightChannel(source[0], backdrop[0]),
    softLightChannel(source[1], backdrop[1]),
    softLightChannel(source[2], backdrop[2]),
  ];
}

function softLightChannel(source: number, backdrop: number): number {
  const s = source / 255;
  const b = backdrop / 255;
  const value =
    s <= 0.5
      ? b - (1 - 2 * s) * b * (1 - b)
      : b + (2 * s - 1) * (softLightCurve(b) - b);
  return Math.round(clamp(value, 0, 1) * 255);
}

function softLightCurve(value: number): number {
  if (value <= 0.25) {
    return ((16 * value - 12) * value + 4) * value;
  }
  return Math.sqrt(value);
}

/**
 * One blended channel. `interpolateRgbStates` is the only caller and needs the
 * three channels separately, so that it can key the dedupe on them and build
 * the tuple only for a colour it has not already emitted; this keeps the
 * rounding rule in one place rather than inlined at the call site.
 */
function mixChannel(left: number, right: number, alpha: number): number {
  return Math.round(left * (1 - alpha) + right * alpha);
}

function extractCssColors(value: string): Rgba[] {
  if (!value) return [];
  const samples: Rgba[] = [];

  for (const match of value.matchAll(/#[\da-f]{3,8}(?![\da-f])/gi)) {
    const parsed = parseHex(match[0]);
    if (parsed) samples.push(parsed);
  }
  for (const match of value.matchAll(/\brgba?\(([^)]+)\)/gi)) {
    const parsed = parseRgbFunction(match[1]);
    if (parsed) samples.push(parsed);
  }
  for (const match of value.matchAll(/\bhsla?\(([^)]+)\)/gi)) {
    const parsed = parseHslFunction(match[1]);
    if (parsed) samples.push(parsed);
  }
  for (const match of value.matchAll(/\b(?:black|white)\b/gi)) {
    samples.push({
      rgb: match[0].toLowerCase() === "black" ? BLACK_RGB : WHITE_RGB,
      alpha: 1,
    });
  }
  return samples;
}

function parseCssColor(value: string): Rgba | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "black") return { rgb: BLACK_RGB, alpha: 1 };
  if (trimmed.toLowerCase() === "white") return { rgb: WHITE_RGB, alpha: 1 };
  if (trimmed.startsWith("#")) return parseHex(trimmed);
  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) return parseRgbFunction(rgbMatch[1]);
  const hslMatch = trimmed.match(/^hsla?\(([^)]+)\)$/i);
  if (hslMatch) return parseHslFunction(hslMatch[1]);
  return null;
}

function parseHex(value: string): Rgba | null {
  const body = value.trim().slice(1);
  if (![3, 4, 6, 8].includes(body.length) || !/^[\da-f]+$/i.test(body)) return null;
  const expanded =
    body.length === 3 || body.length === 4
      ? body.split("").map((channel) => channel + channel).join("")
      : body;
  const rgb = [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ] as const;
  const alpha =
    expanded.length === 8
      ? Number.parseInt(expanded.slice(6, 8), 16) / 255
      : 1;
  return { rgb, alpha };
}

function parseRgbFunction(value: string): Rgba | null {
  const normalized = value.replace(/\s*\/\s*/g, ",");
  const parts = normalized.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map(parseRgbChannel);
  if (rgb.some((channel) => channel === null)) return null;
  const alpha = parts[3] ? parseAlpha(parts[3]) : 1;
  if (alpha === null) return null;
  return {
    rgb: [rgb[0]!, rgb[1]!, rgb[2]!] as const,
    alpha,
  };
}

function parseHslFunction(value: string): Rgba | null {
  const normalized = value.replace(/\s*\/\s*/g, ",");
  const parts = normalized.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const hue = Number.parseFloat(parts[0] ?? "");
  const saturation = parsePercentage(parts[1] ?? "");
  const lightness = parsePercentage(parts[2] ?? "");
  const alpha = parts[3] ? parseAlpha(parts[3]) : 1;
  if (
    !Number.isFinite(hue) ||
    saturation === null ||
    lightness === null ||
    alpha === null
  ) {
    return null;
  }

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hueSegment = (((hue % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
  const match = lightness - chroma / 2;
  const [r, g, b] =
    hueSegment < 1
      ? [chroma, secondary, 0]
      : hueSegment < 2
        ? [secondary, chroma, 0]
        : hueSegment < 3
          ? [0, chroma, secondary]
          : hueSegment < 4
            ? [0, secondary, chroma]
            : hueSegment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  return {
    rgb: [
      Math.round((r + match) * 255),
      Math.round((g + match) * 255),
      Math.round((b + match) * 255),
    ],
    alpha,
  };
}

function parseRgbChannel(value: string): number | null {
  if (value.endsWith("%")) {
    const percentage = parsePercentage(value);
    return percentage === null ? null : Math.round(percentage * 255);
  }
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  return clamp(Math.round(numeric), 0, 255);
}

function parsePercentage(value: string): number | null {
  if (!value.endsWith("%")) return null;
  const numeric = Number.parseFloat(value.slice(0, -1));
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric / 100, 0, 1);
}

function parseAlpha(value: string): number | null {
  if (value.endsWith("%")) return parsePercentage(value);
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, 0, 1);
}

function compositeRgb(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) =>
      Math.round(channel * alpha + background[index] * (1 - alpha)),
  ) as unknown as Rgb;
}

function contrastRatio(left: Rgb, right: Rgb): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The sRGB transfer of each of the 256 possible 8-bit channel values.
 *
 * The same expression as before, evaluated 256 times at module load instead of
 * once per lookup — a table, not an approximation, so every luminance below is
 * bit-identical to the one this module used to compute. It earns its place
 * because this is the hottest arithmetic here: `requiredVeilOpacity` bisects 18
 * times for every (sample, text colour) pair that fails, and `concept-am` alone
 * evaluated the two `**` calls about 14 million times for one veil.
 */
const CHANNEL_LUMINANCE = (() => {
  const table = new Float64Array(256);
  for (let channel = 0; channel < 256; channel += 1) {
    const normalized = channel / 255;
    table[channel] =
      normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

function relativeLuminance(rgb: Rgb): number {
  const r = CHANNEL_LUMINANCE[rgb[0]]!;
  const g = CHANNEL_LUMINANCE[rgb[1]]!;
  const b = CHANNEL_LUMINANCE[rgb[2]]!;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}


function rgbChannels(value: Rgb): string {
  return value.join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundOpacity(value: number): number {
  return Math.round(value * 1000) / 1000;
}
