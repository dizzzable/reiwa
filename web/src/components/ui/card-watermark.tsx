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

import type { CardLogoPreset } from "@/types/branding";
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
  readonly className?: string;
}

export function CardWatermark({ preset, customUrl, className }: CardWatermarkProps) {
  // Custom image wins.
  if (customUrl) {
    return (
      <img
        src={customUrl}
        alt=""
        aria-hidden
        className={cn("pointer-events-none object-contain opacity-[0.12]", className)}
      />
    );
  }

  if (preset === "NONE") return null;

  if (preset === "DEFAULT") {
    return <ReiwaLogo className={cn("pointer-events-none text-white/10", className)} />;
  }

  const Icon = PRESET_ICON[preset];
  if (!Icon) {
    // Unknown preset → fall back to the Reiwa mark rather than nothing.
    return <ReiwaLogo className={cn("pointer-events-none text-white/10", className)} />;
  }

  return (
    <Icon
      aria-hidden
      strokeWidth={1.5}
      className={cn("pointer-events-none text-white/10", className)}
    />
  );
}
