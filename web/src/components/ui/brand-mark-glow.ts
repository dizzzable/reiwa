/**
 * Brand-mark glow — the light that traces the mark's own outline.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT A PLATE
 * ────────────────────────────────────────────────────────────────────────────
 * The tile used to paint a rounded square and light ITS edge: a 1 px inset
 * ring plus a box-shadow bloom. With a transparent mark that filled the tile
 * (the shipped `fill: 1`) the square was the only thing the eye could see
 * framing the logo — a glowing box with a picture inside, whatever the picture
 * was. Any uploaded mark therefore arrived "inside a highlighted square", and
 * nothing the operator could upload changed that.
 *
 * A CSS `drop-shadow` is computed from the element's ALPHA CHANNEL, so chained
 * on the mark it traces whatever silhouette that mark has — an SVG viewBox with
 * its own padding, a PNG with a cut-out, the built-in origami glyph. No
 * silhouette extraction, no canvas, no per-file work: the shape comes from the
 * image itself. That is the whole mechanism, and it is why this file exists
 * apart from the tile: the numbers are tuned per frame below and the tile only
 * decides where to put the result.
 *
 * The colour is mixed from `--brand-primary` rather than reusing
 * `--color-brand-glow` (a fixed 40 % wash) so `glow` can actually drive how
 * strong the light is: at 0.1 the halo is a breath, at 1 it is a lit edge.
 * `color-mix` is already the vocabulary of this bundle's token layer.
 */

import type { BrandLogoFrame } from "@/types/branding";

/** The part of `BrandLogo` this module reads. */
export interface BrandMarkGlowInput {
  readonly frame: BrandLogoFrame;
  /** 0–1, already clamped by `resolveBrandLogo`. */
  readonly glow: number;
}

/** A glow colour whose alpha follows the operator's `glow`. */
function glowColor(glow: number, weight: number): string {
  const alpha = Math.round(Math.min(100, 26 + 58 * glow) * weight);
  return `color-mix(in oklab, var(--brand-primary) ${alpha}%, transparent)`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The CSS `filter` for the wrapper around the mark, or `undefined` when the
 * operator turned the light off (`glow: 0` and/or `frame: none` — a bare mark).
 *
 * Frame decides the SHAPE of the light, not whether a plate is painted:
 *
 *  - `glass`   — no plate at all, a soft halo tracing the mark. This is the
 *                default and the look the glowing square is being replaced by.
 *  - `solid`   — a plate is painted by the tile, the light becomes a tight rim
 *                so the plate keeps its own silhouette instead of bleeding.
 *  - `outline` — a contour line: sub-pixel shadows in four directions, so the
 *                edge is drawn rather than bloomed.
 *  - `none`    — nothing but the mark.
 */
export function resolveBrandMarkGlow(input: BrandMarkGlowInput): string | undefined {
  const glow = Math.min(1, Math.max(0, input.glow));
  if (glow <= 0) return undefined;

  // Radii grow with the setting; the floor keeps a weak glow from collapsing
  // into a 1 px smear that reads as a rendering artefact rather than light.
  const scale = 0.55 + 0.45 * glow;

  switch (input.frame) {
    case "none":
      return undefined;

    case "outline": {
      // A drawn edge. Zero blur, four sub-pixel offsets: chained, each one
      // widens the rim by its own offset, so the mark ends up wearing a ~1.5 px
      // light line and no bloom.
      const edge = glowColor(glow, 1);
      const px = round(0.5 + 0.5 * glow);
      return [
        `drop-shadow(0 ${px}px 0 ${edge})`,
        `drop-shadow(0 -${px}px 0 ${edge})`,
        `drop-shadow(${px}px 0 0 ${edge})`,
        `drop-shadow(-${px}px 0 0 ${edge})`,
      ].join(" ");
    }

    case "solid": {
      // The plate already separates the mark from the page, so only a close
      // rim — a wide halo here would bloom out of the plate's square corners
      // and re-create the glowing box this change removes.
      const rim = glowColor(glow, 0.9);
      return [`drop-shadow(0 0 ${round(0.8 * scale)}px ${rim})`, `drop-shadow(0 0 ${round(4 * scale)}px ${rim})`].join(
        " ",
      );
    }

    case "glass":
    default: {
      // Three chained passes, each computed from the previous one's output: a
      // sub-pixel pass draws the lit contour itself (this is the "line" that
      // used to be the plate's ring), a 2 px pass softens that edge, and the
      // last one carries the bloom. The bloom is deliberately short and faint
      // — chained shadows multiply near the silhouette, and a wide, strong
      // outer pass turns the whole mark into a milky blob instead of a lit one.
      const line = glowColor(glow, 1);
      const haze = glowColor(glow, 0.55);
      return [
        `drop-shadow(0 0 ${round(0.5 + 0.5 * glow)}px ${line})`,
        `drop-shadow(0 0 ${round(1.5 + 2 * glow)}px ${line})`,
        `drop-shadow(0 0 ${round(6 + 9 * scale)}px ${haze})`,
      ].join(" ");
    }
  }
}

/**
 * Whether the tile paints a plate behind the mark. Only `solid` does now:
 * `glass` is the airy, plate-less default, `outline` is the mark's own contour
 * and `none` is the mark alone. Kept next to the glow so the two cannot drift
 * apart — a plate without a rim, or a rim promised for a plate that is not
 * there, is exactly the visual bug this file was written to stop repeating.
 */
export function brandMarkPlateVisible(frame: BrandLogoFrame): boolean {
  return frame === "solid";
}
