/**
 * Brand-mark tile geometry — the arithmetic that turns the operator's
 * `brandLogo` knobs into pixels.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MIRRORED IN THE PANEL:
 * `rezeis/rezeis-admin/web/src/features/branding/brand-logo-geometry.ts`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Two repositories, two copies, and no suite in either one can catch drift
 * between them — each passes happily while the other computes something else.
 * So the formula is kept trivial, both sides carry the same fixed table in
 * their own tests, and each names the other file. That is a mitigation, not a
 * guarantee: change the arithmetic here and change it there in the same
 * change-set, or the panel's preview promises a rendering this cabinet does not
 * produce — which is the exact complaint that created the setting.
 *
 * The base sizes are this file's own: `md` is every form screen (sign-in,
 * change password), `lg` the splash screens (`/`, `/tma`). They are what
 * `EntryBrandTile` drew as `h-20 w-20` and `h-24 w-24` before the knobs
 * existed.
 */

import type { BrandLogo } from "@/types/branding";

export const BRAND_LOGO_TILE_BASE_PX = { md: 80, lg: 96 } as const;

export type BrandLogoTileVariant = keyof typeof BRAND_LOGO_TILE_BASE_PX;

/**
 * What the tile's old Tailwind classes actually resolved to.
 *
 * `rounded-3xl` is `calc(var(--radius) * 2.2)` and `rounded-xl` is
 * `calc(var(--radius) * 1.4)` (the `--radius-*` scale in `index.css`), and
 * `--radius` is the operator's item radius. So the `md` tile FOLLOWED the
 * theme, and reproducing "what it drew before" means following it still. A
 * fixed percentage would have rounded off a theme configured with sharp corners
 * and flattened one configured round — on the first screen every subscriber
 * sees, for every deployment that changed nothing. The `lg` tile was the
 * literal `rounded-[28px]` and followed nothing.
 */
const INHERITED_TILE_RADIUS_FACTOR = 2.2;
const INHERITED_MARK_RADIUS_FACTOR = 1.4;
const INHERITED_LG_TILE_RADIUS_PX = 28;

export interface BrandLogoGeometryInput {
  /** Which entry screen's tile. */
  readonly variant: BrandLogoTileVariant;
  readonly logo: Pick<BrandLogo, "size" | "fill" | "radius" | "frame">;
  /**
   * The document's resolved `--radius`, in px. Consulted only while the
   * operator leaves `radius` unset; see `resolveItemRadiusPx`.
   */
  readonly itemRadiusPx: number;
}

export interface BrandLogoGeometry {
  /** Outer box, and the space the tile occupies in layout. */
  readonly tilePx: number;
  /** The mark's own box inside it. */
  readonly markPx: number;
  readonly tileRadiusPx: number;
  /**
   * Corner radius of the mark. While the tile's radius is inherited this is
   * inherited too — `rounded-xl`, exactly as before. Once the operator sets a
   * radius the mark's curve is made concentric with the tile's rather than
   * parallel to it (`r_inner = r_outer − inset`), because a mark clipped with
   * the tile's own radius reads as a second, tighter corner inside the first.
   */
  readonly markRadiusPx: number;
}

/**
 * Rounded to a hundredth of a pixel. `96 × 0.58` is 55.67999999999999 in binary
 * floating point, and emitting that verbatim puts an artefact of the evaluation
 * order into the stylesheet and into every test that pins it. A hundredth of a
 * CSS pixel is below the resolution of any display, so nothing is lost — but
 * BOTH repositories must round, or the panel's preview and this cabinet
 * disagree in the last digits of every declaration.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function resolveBrandLogoGeometry(input: BrandLogoGeometryInput): BrandLogoGeometry {
  const { variant, logo, itemRadiusPx } = input;
  const tilePx = BRAND_LOGO_TILE_BASE_PX[variant] * logo.size;
  const markPx = tilePx * logo.fill;

  if (logo.radius === null) {
    return {
      tilePx: round(tilePx),
      markPx: round(markPx),
      tileRadiusPx: round(
        variant === "lg"
          ? INHERITED_LG_TILE_RADIUS_PX
          : itemRadiusPx * INHERITED_TILE_RADIUS_FACTOR,
      ),
      markRadiusPx: round(itemRadiusPx * INHERITED_MARK_RADIUS_FACTOR),
    };
  }

  const tileRadiusPx = (tilePx * logo.radius) / 100;
  // With no plate there is no inner edge to stay clear of, so the mark takes
  // the tile's own rounding instead of an inset one.
  const inset = logo.frame === "none" ? 0 : (tilePx - markPx) / 2;
  return {
    tilePx: round(tilePx),
    markPx: round(markPx),
    tileRadiusPx: round(tileRadiusPx),
    markRadiusPx: round(Math.max(0, tileRadiusPx - inset)),
  };
}
