/**
 * The brand colour as something drawn ON a card — an icon, a dot, a ring, a
 * bar — rather than as a button's fill.
 *
 * A button carries its own contrast: it is filled with the primary and its
 * label is `primaryFg`, which the operator picks against it. An icon has
 * nothing behind it but the card, and the primary is chosen for buttons, not
 * for that. Of the 104 light concept themes in the panel (30.10.2026), 57 put
 * the primary below 3:1 against their own card and 34 below 2:1 — a pale
 * lime on off-white, and in one theme the very colour of the card itself.
 * An icon in that colour is not there.
 *
 * So: the primary itself whenever it stands out at 3:1 (WCAG 1.4.11, for
 * graphics), and otherwise the primary moved toward the theme's text colour
 * just far enough — darker on a light card, lighter on a dark one, still the
 * brand's hue. Mixing happens in OKLab, where halfway looks halfway.
 *
 * The card is taken as the theme's surface over its background colour. An
 * app background image or gradient is not sampled; the surface is nearly
 * opaque in every concept theme, so what shows through barely moves it.
 */

const MIN_CONTRAST = 3;

type Rgb = readonly [number, number, number];

export interface InkSurface {
  readonly foreground: string;
  readonly surface: string;
  readonly surfaceOpacity: number;
}

export function readableBrandInk(primary: string, theme: InkSurface, background: string): string {
  const brand = parseHex(primary);
  const text = parseHex(theme.foreground);
  const surface = parseHex(theme.surface);
  const backdrop = parseHex(background);
  if (brand === null || text === null || surface === null || backdrop === null) return primary;

  const alpha = Number.isFinite(theme.surfaceOpacity) ? Math.min(1, Math.max(0, theme.surfaceOpacity)) : 1;
  const card: Rgb = [0, 1, 2].map((i) => surface[i]! * alpha + backdrop[i]! * (1 - alpha)) as unknown as Rgb;
  if (contrast(brand, card) >= MIN_CONTRAST) return primary;

  // Twentieths: the first share of the brand that clears the bar, so a colour
  // that is nearly there moves only a little.
  for (let step = 19; step >= 0; step -= 1) {
    const ink = mixOklab(brand, text, step / 20);
    if (contrast(ink, card) >= MIN_CONTRAST) return toHex(ink);
  }
  return theme.foreground;
}

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((d) => d + d).join("") : match[1]!;
  const n = Number.parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Rounded here, so the contrast checked is the contrast of the colour written. */
function gamma(channel: number): number {
  const c = Math.min(1, Math.max(0, channel));
  return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
}

function luminance(rgb: Rgb): number {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `share` of `a`, the rest `b` — as `color-mix(in oklab, a share, b)`. */
function mixOklab(a: Rgb, b: Rgb, share: number): Rgb {
  const left = toOklab(a);
  const right = toOklab(b);
  return fromOklab([0, 1, 2].map((i) => left[i]! * share + right[i]! * (1 - share)) as unknown as Rgb);
}

function toOklab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: Rgb): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
