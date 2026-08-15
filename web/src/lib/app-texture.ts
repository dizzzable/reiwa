/**
 * app-texture
 * ───────────
 * Builds pure-CSS, static, tileable background textures from an operator's
 * `appBackground.texture` config. No WebGL, no canvas — just an inline SVG
 * `data:` URI as `background-image` over a base colour, so it is essentially
 * free to render and never flickers.
 *
 * Mirrors `APP_BACKGROUND_TEXTURES` on the backend. Adding a pattern here must
 * be matched in the admin texture picker + the backend allow-list.
 */
import type { AppBackgroundTexture, AppBackgroundTextureSettings } from "@/types/branding";

export interface TextureCss {
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  readonly backgroundSize: string;
}

/**
 * Fold an operator-supplied opacity into the 0…1 that CSS and SVG accept.
 *
 * The failure being prevented is not a wrong colour, it is a DROPPED
 * DECLARATION: `rgba(170,29,139,1.7)` and `rgba(170,29,139,NaN)` are not valid
 * values, so the browser discards the entire `fill`/`stroke` and the element
 * keeps whatever it inherited. Nothing is logged and nothing on screen points
 * back at the opacity control, which makes it read as "the setting did nothing".
 *
 * NaN maps to 1, not to 0. `Number()` over a settings blob yields NaN from a
 * missing key or a non-numeric string, and between the two failure modes an
 * over-visible pattern is one the operator can see and report, while an
 * invisible one is indistinguishable from the bug above. `Number.isNaN` rather
 * than `!Number.isFinite` so that ±Infinity still clamps by magnitude — -Infinity
 * means "as transparent as possible" and answering 1 would invert it.
 *
 * The explicit NaN test is load-bearing: `Math.min(Math.max(NaN, 0), 1)` is NaN,
 * so a clamp on its own does not cover it.
 *
 * This side needs it most: the cabinet passes `branding.appBackground.texture`
 * from the API payload straight into `buildTextureCss`, with no schema or
 * normaliser in between — unlike the panel, where `branding-form-schema.ts`
 * bounds the draft first.
 */
function clampAlpha(alpha: number): number {
  if (Number.isNaN(alpha)) return 1;
  return Math.min(Math.max(alpha, 0), 1);
}

/** Convert `#rrggbb` (or shorthand) + alpha → `rgba(...)`. Falls back safely. */
function hexToRgba(hex: string, alpha: number): string {
  // Clamped once, up front, so BOTH exits below are covered. The unparseable
  // -colour fallback used to interpolate the raw `alpha`, which meant the
  // branch whose whole job is to keep the tile visible emitted the invalid
  // declaration instead.
  const a = clampAlpha(alpha);
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(255,255,255,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Returns the raw inner SVG markup (a 40×40 tile) for a pattern id. */
function patternSvg(
  pattern: AppBackgroundTexture,
  stroke: string,
  opacity: number,
): string {
  switch (pattern) {
    case "dots":
      return `<circle cx="20" cy="20" r="2.4" fill="${stroke}"/>`;
    case "grid":
      return `<path d="M0 0H40M0 0V40" stroke="${stroke}" stroke-width="1.2" fill="none"/>`;
    case "diagonal":
      return `<path d="M-4 4L4 -4M0 40L40 0M36 44L44 36" stroke="${stroke}" stroke-width="1.4" fill="none"/>`;
    case "cross":
      return `<path d="M20 14V26M14 20H26" stroke="${stroke}" stroke-width="1.4" fill="none"/>`;
    case "waves":
      return `<path d="M0 30 Q10 18 20 30 T40 30" stroke="${stroke}" stroke-width="1.4" fill="none"/>`;
    case "carbon":
      return `<path d="M0 10H20V30H40M0 30H20V10H40" stroke="${stroke}" stroke-width="1.2" fill="none"/>`;
    case "triangles":
      return `<path d="M20 8L32 30H8Z" stroke="${stroke}" stroke-width="1.2" fill="none"/>`;
    case "noise":
      return (
        `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise"/>` +
        `<feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.75 0" result="mask"/>` +
        `<feFlood flood-color="${stroke}" flood-opacity="${clampAlpha(opacity)}" result="tint"/>` +
        `<feComposite in="tint" in2="mask" operator="in"/></filter>` +
        `<rect width="40" height="40" filter="url(#n)"/>`
      );
    default:
      return `<circle cx="20" cy="20" r="2.4" fill="${stroke}"/>`;
  }
}

/**
 * Build the CSS for a tiled texture background. The pattern opacity is baked
 * into the SVG stroke colour (rgba) so a single element carries both the base
 * colour and the faded pattern.
 */
export function buildTextureCss(texture: AppBackgroundTextureSettings): TextureCss {
  const stroke =
    texture.pattern === "noise"
      ? texture.color // noise uses its own alpha channel
      : hexToRgba(texture.color, texture.opacity);
  const inner = patternSvg(texture.pattern, stroke, texture.opacity);
  // For noise we still apply the operator opacity via the rect's own opacity.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">${inner}</svg>`;
  const encoded = encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
  const size = Math.min(Math.max(Math.round(texture.scale), 8), 256);
  return {
    backgroundColor: texture.background,
    backgroundImage: `url("data:image/svg+xml,${encoded}")`,
    backgroundSize: `${size}px ${size}px`,
  };
}
