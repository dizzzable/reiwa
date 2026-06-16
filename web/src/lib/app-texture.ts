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

/** Convert `#rrggbb` (or shorthand) + alpha → `rgba(...)`. Falls back safely. */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.min(Math.max(alpha, 0), 1);
  return `rgba(${r},${g},${b},${a})`;
}

/** Returns the raw inner SVG markup (a 40×40 tile) for a pattern id. */
function patternSvg(pattern: AppBackgroundTexture, stroke: string): string {
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
        `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>` +
        `<feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.6 0"/></filter>` +
        `<rect width="40" height="40" filter="url(#n)" opacity="0.5"/>`
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
  const inner = patternSvg(texture.pattern, stroke);
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
