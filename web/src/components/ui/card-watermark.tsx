/**
 * CardWatermark
 * ─────────────
 * The faint glyph that sits in the corner of the subscription card. Driven by
 * the operator's branding:
 *   - `cardLogoUrl` set        → render the custom image (low opacity).
 *   - `cardLogo === "DEFAULT"` → the canonical Reiwa origami mark.
 *   - `cardLogo === "NONE"`    → nothing.
 *   - any other preset key     → the mapped Lucide glyph, tinted white.
 *
 * Built-in glyphs are Lucide icons (tintable, scalable, zero extra assets), so
 * adding a preset is just one entry in `PRESET_ICON` + the backend list + the
 * admin grid.
 */

import {
  Crown,
  Flame,
  Gem,
  Ghost,
  Globe,
  Hexagon,
  Mountain,
  Orbit,
  Rocket,
  Shield,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { CSSProperties } from "react";

import { resolveCardLogoStyle, type CardLogoPreset, type CardLogoStyle } from "@/types/branding";
import { ReiwaLogo } from "./reiwa-logo";
import { cn } from "@/lib/utils";

/** Maps a preset key to its Lucide glyph. DEFAULT/NONE handled separately. */
const PRESET_ICON: Partial<Record<CardLogoPreset, LucideIcon>> = {
  SHIELD: Shield,
  BOLT: Zap,
  GLOBE: Globe,
  ROCKET: Rocket,
  GHOST: Ghost,
  CROWN: Crown,
  GEM: Gem,
  FLAME: Flame,
  WAVES: Waves,
  MOUNTAIN: Mountain,
  ORBIT: Orbit,
  HEXAGON: Hexagon,
};

interface CardWatermarkProps {
  readonly preset: CardLogoPreset;
  readonly customUrl?: string | null;
  /**
   * Operator-set size and weight, straight off the branding payload. Absent
   * means a panel older than the setting, not "no styling"; it is resolved
   * HERE rather than by each caller, so a malformed or missing object cannot
   * reach a card, and a fourth call site cannot forget to normalize it.
   */
  readonly style?: CardLogoStyle;
  /**
   * The mark's box at `scale: 1`, in px. Each surface has its own: the
   * dashboard card is larger than the picker card, and the operator's scale
   * multiplies whichever it is rather than flattening the three to one size.
   *
   * A caller whose base changes with the container sets
   * `--card-watermark-base` in its className instead; this value is the
   * fallback for that variable, so both kinds of caller take one code path.
   */
  readonly basePx: number;
  readonly className?: string;
}

/**
 * Size and opacity are inline, not classes, for one reason each: the size is a
 * number the operator picks, and the opacity used to be three different values
 * across three call sites. The custom-image branch carried `opacity-[0.12]`
 * while two of its three callers overrode it back to `opacity-10` and the third
 * did not — so the same uploaded mark was visibly fainter on the dashboard than
 * in the subscription picker, for no reason anybody chose. One value now feeds
 * both branches and every caller.
 */
export function CardWatermark({
  preset,
  customUrl,
  style,
  basePx,
  className,
}: CardWatermarkProps) {
  const resolved = resolveCardLogoStyle(style);
  const size = `calc(var(--card-watermark-base, ${basePx}px) * ${resolved.scale})`;
  const box: CSSProperties = { width: size, height: size, opacity: resolved.opacity };

  // Custom image wins.
  if (customUrl) {
    return (
      <img
        src={customUrl}
        alt=""
        aria-hidden
        data-card-watermark="image"
        className={cn("pointer-events-none object-contain", className)}
        style={box}
      />
    );
  }

  if (preset === "NONE") return null;

  // Unknown presets fall back to the Reiwa mark rather than to nothing: the
  // panel ships new glyphs on its own cadence, and an unrecognised name means
  // "this build has not learned it yet", not "the operator wants no mark".
  const Icon = preset === "DEFAULT" ? null : PRESET_ICON[preset];
  if (!Icon) {
    return (
      <ReiwaLogo
        data-card-watermark="mark"
        className={cn("pointer-events-none text-white", className)}
        style={box}
      />
    );
  }

  return (
    <Icon
      aria-hidden
      strokeWidth={1.5}
      data-card-watermark="glyph"
      className={cn("pointer-events-none text-white", className)}
      style={box}
    />
  );
}
