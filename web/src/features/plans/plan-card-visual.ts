/**
 * plan-card-visual
 * ────────────────
 * Resolves the static visual for a tariff card on the `/plans` page from the
 * operator's per-plan `branding.planCardStyles[planId]`, falling back to a
 * deterministic auto gradient so unconfigured (and archived) plans still look
 * distinct from one another. Pure — no React, no WebGL (the tariff list stays
 * light; animated effects remain exclusive to the subscription carousel).
 */
import { buildTextureCss } from "@/lib/app-texture";
import type { Branding } from "@/types/branding";

/**
 * Deterministic gradient from a plan id. Same hash the WEB Reiwa configurator
 * preview uses, so the admin preview and the cabinet agree pixel-for-hue.
 */
export function autoPlanGradient(planId: string): string {
  let h = 0;
  for (let i = 0; i < planId.length; i += 1) {
    h = (h * 31 + planId.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 40) % 360} 65% 32%))`;
}

export interface ResolvedPlanCardStyle {
  /** CSS background gradient for the card. */
  readonly gradient: string;
  /** Accent hex for price/name, or `null` to use the brand primary. */
  readonly accent: string | null;
  /** Operator-uploaded texture image URL (cover overlay), or `null`. */
  readonly textureUrl: string | null;
  /** CSS background-image for a built-in texture preset, or `null`. */
  readonly textureImage: string | null;
  /** CSS background-size for the preset texture tile, or `null`. */
  readonly textureSize: string | null;
}

/** Resolve the effective card style for a plan (configured → else auto). */
export function resolvePlanCardStyle(planId: string, branding: Branding): ResolvedPlanCardStyle {
  const style = branding.planCardStyles?.[planId];
  const gradient =
    style?.gradient && style.gradient.length > 0 ? style.gradient : autoPlanGradient(planId);
  const accent = style?.accent && style.accent.length > 0 ? style.accent : null;
  const textureUrl = style?.textureUrl && style.textureUrl.length > 0 ? style.textureUrl : null;

  let textureImage: string | null = null;
  let textureSize: string | null = null;
  if (!textureUrl && style?.texturePreset) {
    const css = buildTextureCss({
      pattern: style.texturePreset,
      color: accent ?? "#ffffff",
      background: "transparent",
      scale: 18,
      opacity: 0.5,
    });
    textureImage = css.backgroundImage;
    textureSize = css.backgroundSize;
  }

  return { gradient, accent, textureUrl, textureImage, textureSize };
}
