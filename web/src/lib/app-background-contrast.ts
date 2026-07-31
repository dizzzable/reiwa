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
  const edgeOpacity = roundOpacity(
    clamp(chosen.veilOpacity + 0.12, 0, MAX_VEIL_OPACITY),
  );

  return {
    veilRgb: channels,
    veilOpacity: chosen.veilOpacity,
    overlayBackground:
      `linear-gradient(180deg, ` +
      `rgb(${channels} / ${edgeOpacity}) 0%, ` +
      `rgb(${channels} / ${chosen.veilOpacity}) 16%, ` +
      `rgb(${channels} / ${chosen.veilOpacity}) 28%, ` +
      `rgb(${channels} / ${chosen.veilOpacity}) 40%, ` +
      `rgb(${channels} / ${chosen.veilOpacity}) 60%, ` +
      `rgb(${channels} / ${chosen.veilOpacity}) 72%, ` +
      `rgb(${channels} / ${chosen.veilOpacity}) 84%, ` +
      `rgb(${channels} / ${edgeOpacity}) 100%)`,
  };
}

interface VeilCandidate {
  readonly veilRgb: Rgb;
  readonly rawOpacity: number;
  readonly veilOpacity: number;
}

function resolveBackgroundSamples(
  branding: Pick<Branding, "appBackground" | "bgPrimary" | "themePresetId">,
): Rgb[] {
  const appBackground = branding.appBackground;
  if (!appBackground) return [];
  const texture = appBackground.texture;

  const fallback =
    parseCssColor(appBackground.kind === "texture" ? texture?.background ?? branding.bgPrimary : branding.bgPrimary)?.rgb ??
    null;

  if (appBackground.kind === "none") return [];
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

function resolveSoftLightTextureSamples(
  baseSamples: readonly Rgb[],
  textureColor: Rgb,
  opacity: number,
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
  return uniqueRgb([
    ...textured,
    ...interpolateRgbStates(textured),
  ]);
}

function interpolateRgbStates(samples: readonly Rgb[]): Rgb[] {
  const blended: Rgb[] = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      blended.push(mixRgb(samples[left]!, samples[right]!, 0.25));
      blended.push(mixRgb(samples[left]!, samples[right]!, 0.5));
      blended.push(mixRgb(samples[left]!, samples[right]!, 0.75));
    }
  }
  return uniqueRgb(blended);
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

function mixRgb(left: Rgb, right: Rgb, alpha: number): Rgb {
  return [
    Math.round(left[0] * (1 - alpha) + right[0] * alpha),
    Math.round(left[1] * (1 - alpha) + right[1] * alpha),
    Math.round(left[2] * (1 - alpha) + right[2] * alpha),
  ];
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

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
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
