/**
 * Contrast tokens for artwork-backed cards.
 *
 * Subscription and tariff cards can be configured with arbitrary gradients.
 * A fixed white foreground + black vignette works only for dark artwork. This
 * resolver samples the colours present in a CSS gradient, chooses the cheaper
 * WCAG-AA foreground, then calculates the smallest supporting veil that keeps
 * every sampled stop readable. Unknown/custom CSS falls back to the semantic
 * foreground and canvas supplied by branding.
 */

const DARK_FOREGROUND = "#0a0a0a";
const LIGHT_FOREGROUND = "#ffffff";
const WHITE_RGB: Rgb = [255, 255, 255];
const BLACK_RGB: Rgb = [0, 0, 0];
const MINIMUM_TEXT_CONTRAST = 4.5;
const MINIMUM_VEIL_OPACITY = 0.12;
const VEIL_SAFETY_MARGIN = 0.025;

type Rgb = readonly [number, number, number];

interface Rgba {
  readonly rgb: Rgb;
  readonly alpha: number;
}

export interface CardContrast {
  /** `dark` means dark text on light artwork; `light` means the inverse. */
  readonly foregroundTone: "dark" | "light";
  readonly foreground: string;
  /** Space-separated channels for CSS Color 4: `rgb(var(...) / alpha)`. */
  readonly foregroundRgb: string;
  /** Opposite tone used as the contrast-supporting artwork veil. */
  readonly veilRgb: string;
  readonly veilOpacity: number;
  readonly overlayBackground: string;
  readonly foundation: string;
  /** Representative post-veil colour, used for readable accent adjustment. */
  readonly effectiveBackground: string;
  /** A slightly stronger, opaque support colour for compact text chips. */
  readonly supportBackground: string;
}

export interface CardContrastOptions {
  readonly fallbackBackground?: string | null;
  readonly preferredForeground?: string | null;
  readonly minimumVeilOpacity?: number;
}

export function resolveCardContrast(
  artwork: string,
  options: CardContrastOptions = {},
): CardContrast {
  const fallback = parseCssColor(options.fallbackBackground ?? "");
  const rawSamples = extractCssColors(artwork);
  const samples = (
    rawSamples.length > 0
      ? rawSamples
      : fallback
        ? [fallback]
        : []
  ).map((sample) =>
    sample.alpha < 1
      ? compositeRgb(
          sample.rgb,
          fallback?.rgb ?? (preferredForegroundIsLight(options) ? BLACK_RGB : WHITE_RGB),
          sample.alpha,
        )
      : sample.rgb,
  );

  const resolvedSamples =
    samples.length > 0
      ? samples
      : preferredForegroundIsLight(options)
        ? [BLACK_RGB]
        : [WHITE_RGB];

  const darkRequirement = requiredVeilOpacity(
    resolvedSamples,
    parseCssColor(DARK_FOREGROUND)!.rgb,
    WHITE_RGB,
  );
  const lightRequirement = requiredVeilOpacity(
    resolvedSamples,
    WHITE_RGB,
    BLACK_RGB,
  );
  const prefersLight = preferredForegroundIsLight(options);
  const foregroundTone =
    Math.abs(darkRequirement - lightRequirement) <= 0.015
      ? prefersLight
        ? "light"
        : "dark"
      : darkRequirement < lightRequirement
        ? "dark"
        : "light";

  const foregroundRgb =
    foregroundTone === "dark"
      ? parseCssColor(DARK_FOREGROUND)!.rgb
      : WHITE_RGB;
  const veilRgb = foregroundTone === "dark" ? WHITE_RGB : BLACK_RGB;
  const rawRequirement =
    foregroundTone === "dark" ? darkRequirement : lightRequirement;
  const minimumVeil = clamp(
    options.minimumVeilOpacity ?? MINIMUM_VEIL_OPACITY,
    0,
    0.75,
  );
  const veilOpacity = roundOpacity(
    clamp(
      Math.max(minimumVeil, rawRequirement + VEIL_SAFETY_MARGIN),
      0,
      0.75,
    ),
  );
  const average = averageRgb(resolvedSamples);
  const effective = compositeRgb(veilRgb, average, veilOpacity);
  const support = compositeRgb(
    veilRgb,
    average,
    clamp(veilOpacity + 0.16, 0, 0.84),
  );
  const topOpacity = roundOpacity(clamp(veilOpacity + 0.12, 0, 0.82));
  const bottomOpacity = roundOpacity(clamp(veilOpacity + 0.16, 0, 0.86));
  const veilChannels = rgbChannels(veilRgb);

  return {
    foregroundTone,
    foreground:
      foregroundTone === "dark" ? DARK_FOREGROUND : LIGHT_FOREGROUND,
    foregroundRgb: rgbChannels(foregroundRgb),
    veilRgb: veilChannels,
    veilOpacity,
    overlayBackground: `linear-gradient(180deg, rgb(${veilChannels} / ${topOpacity}) 0%, rgb(${veilChannels} / ${veilOpacity}) 48%, rgb(${veilChannels} / ${bottomOpacity}) 100%)`,
    foundation:
      nonEmpty(options.fallbackBackground) ??
      (foregroundTone === "dark" ? "#f4f4f5" : "#09090b"),
    effectiveBackground: rgbToHex(effective),
    supportBackground: rgbToHex(support),
  };
}

/**
 * Keeps an operator accent when it is already readable. Otherwise, walks it
 * toward the chosen card foreground until normal-size text reaches WCAG AA.
 */
export function ensureReadableCardAccent(
  accent: string,
  background: string,
  foreground: string,
  minimumContrast = MINIMUM_TEXT_CONTRAST,
): string {
  const accentRgb = parseCssColor(accent)?.rgb;
  const backgroundRgb = parseCssColor(background)?.rgb;
  const foregroundRgb = parseCssColor(foreground)?.rgb;
  if (!accentRgb || !backgroundRgb || !foregroundRgb) {
    return nonEmpty(foreground) ?? LIGHT_FOREGROUND;
  }
  if (contrastRatio(accentRgb, backgroundRgb) >= minimumContrast) {
    return rgbToHex(accentRgb);
  }

  for (let step = 1; step <= 100; step += 1) {
    const candidate = compositeRgb(
      foregroundRgb,
      accentRgb,
      step / 100,
    );
    if (contrastRatio(candidate, backgroundRgb) >= minimumContrast) {
      return rgbToHex(candidate);
    }
  }
  return rgbToHex(foregroundRgb);
}

function requiredVeilOpacity(
  samples: readonly Rgb[],
  foreground: Rgb,
  veil: Rgb,
): number {
  let required = 0;
  for (const sample of samples) {
    if (contrastRatio(foreground, sample) >= MINIMUM_TEXT_CONTRAST) continue;
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const midpoint = (low + high) / 2;
      const composited = compositeRgb(veil, sample, midpoint);
      if (
        contrastRatio(foreground, composited) >=
        MINIMUM_TEXT_CONTRAST
      ) {
        high = midpoint;
      } else {
        low = midpoint;
      }
    }
    required = Math.max(required, high);
  }
  return required;
}

function extractCssColors(value: string): Rgba[] {
  if (!value) return [];
  const samples: Rgba[] = [];

  for (const match of value.matchAll(
    /#[\da-f]{3,8}(?![\da-f])/gi,
  )) {
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
  if (trimmed.toLowerCase() === "black") {
    return { rgb: BLACK_RGB, alpha: 1 };
  }
  if (trimmed.toLowerCase() === "white") {
    return { rgb: WHITE_RGB, alpha: 1 };
  }
  if (trimmed.startsWith("#")) return parseHex(trimmed);
  const rgb = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) return parseRgbFunction(rgb[1]);
  const hsl = trimmed.match(/^hsla?\(([^)]+)\)$/i);
  return hsl ? parseHslFunction(hsl[1]) : null;
}

function parseHex(value: string): Rgba | null {
  let body = value.trim().replace(/^#/, "");
  if (![3, 4, 6, 8].includes(body.length) || !/^[\da-f]+$/i.test(body)) {
    return null;
  }
  if (body.length === 3 || body.length === 4) {
    body = body
      .split("")
      .map((channel) => `${channel}${channel}`)
      .join("");
  }
  const hasAlpha = body.length === 8;
  return {
    rgb: [
      Number.parseInt(body.slice(0, 2), 16),
      Number.parseInt(body.slice(2, 4), 16),
      Number.parseInt(body.slice(4, 6), 16),
    ],
    alpha: hasAlpha
      ? Number.parseInt(body.slice(6, 8), 16) / 255
      : 1,
  };
}

function parseRgbFunction(body: string): Rgba | null {
  const [channelsPart, slashAlpha] = body.split("/").map((part) => part.trim());
  const parts = channelsPart
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map(parseRgbChannel);
  if (rgb.some((channel) => channel === null)) return null;
  const commaAlpha =
    slashAlpha === undefined && parts.length >= 4 ? parts[3] : undefined;
  return {
    rgb: rgb as unknown as Rgb,
    alpha: parseAlpha(slashAlpha ?? commaAlpha),
  };
}

function parseHslFunction(body: string): Rgba | null {
  const [channelsPart, slashAlpha] = body.split("/").map((part) => part.trim());
  const parts = channelsPart
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const hue = Number.parseFloat(parts[0].replace(/deg$/i, ""));
  const saturation = parsePercentage(parts[1]);
  const lightness = parsePercentage(parts[2]);
  if (
    !Number.isFinite(hue) ||
    saturation === null ||
    lightness === null
  ) {
    return null;
  }
  const commaAlpha =
    slashAlpha === undefined && parts.length >= 4 ? parts[3] : undefined;
  return {
    rgb: hslToRgb(hue, saturation, lightness),
    alpha: parseAlpha(slashAlpha ?? commaAlpha),
  };
}

function parseRgbChannel(value: string): number | null {
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value);
    return Number.isFinite(percent)
      ? clamp((percent / 100) * 255, 0, 255)
      : null;
  }
  const channel = Number.parseFloat(value);
  return Number.isFinite(channel) ? clamp(channel, 0, 255) : null;
}

function parsePercentage(value: string): number | null {
  if (!value.endsWith("%")) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? clamp(number / 100, 0, 1) : null;
}

function parseAlpha(value: string | undefined): number {
  if (value === undefined) return 1;
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value);
    return Number.isFinite(percent) ? clamp(percent / 100, 0, 1) : 1;
  }
  const alpha = Number.parseFloat(value);
  return Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x =
    chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  let channels: Rgb;
  if (normalizedHue < 60) channels = [chroma, x, 0];
  else if (normalizedHue < 120) channels = [x, chroma, 0];
  else if (normalizedHue < 180) channels = [0, chroma, x];
  else if (normalizedHue < 240) channels = [0, x, chroma];
  else if (normalizedHue < 300) channels = [x, 0, chroma];
  else channels = [chroma, 0, x];
  return channels.map((channel) => (channel + match) * 255) as unknown as Rgb;
}

function preferredForegroundIsLight(options: CardContrastOptions): boolean {
  const preferred = parseCssColor(options.preferredForeground ?? "");
  return preferred ? relativeLuminance(preferred.rgb) >= 0.5 : true;
}

function compositeRgb(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) =>
      channel * alpha + background[index] * (1 - alpha),
  ) as unknown as Rgb;
}

function averageRgb(colors: readonly Rgb[]): Rgb {
  return [0, 1, 2].map(
    (index) =>
      colors.reduce((sum, color) => sum + color[index], 0) /
      colors.length,
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

function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) =>
      Math.round(clamp(channel, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function rgbChannels(rgb: Rgb): string {
  return rgb.map((channel) => Math.round(channel)).join(" ");
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundOpacity(value: number): number {
  return Math.round(value * 1000) / 1000;
}
