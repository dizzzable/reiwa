/**
 * plan-card-visual
 * ────────────────
 * Resolves the static visual for a tariff card on the `/plans` page from the
 * operator's per-plan `branding.planCardStyles[planId]`, falling back to a
 * deterministic auto gradient so unconfigured (and archived) plans still look
 * distinct from one another. Pure — no React, no WebGL. The tariff card layers
 * an animated card-effect on top of this static visual, EXCEPT when a custom
 * `textureUrl` image is set (then the image wins and the effect is suppressed).
 */
import { buildTextureCss } from "@/lib/app-texture";
import {
  ensureReadableCardAccent,
  resolveCardContrast,
  type CardContrast,
} from "@/lib/card-contrast";
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
  /** Computed foreground + supporting veil for this exact artwork. */
  readonly contrast: CardContrast;
  /** Accent hex for price/name, or `null` to use the brand primary. */
  readonly accent: string | null;
  /** Operator-uploaded texture image URL (cover overlay), or `null`. */
  readonly textureUrl: string | null;
  /** CSS background-image for a built-in texture preset, or `null`. */
  readonly textureImage: string | null;
  /** CSS background-size for the preset texture tile, or `null`. */
  readonly textureSize: string | null;
  /** Per-plan animated effect id (`NONE` = static gradient only). */
  readonly effect: string;
  /** Tunable params for the per-plan effect. */
  readonly effectProps: Record<string, unknown>;
  /** Per-plan effect layer opacity (0.05–1). */
  readonly effectOpacity: number;
}

/** Resolve the effective card style for a plan (configured → else auto). */
export function resolvePlanCardStyle(planId: string, branding: Branding): ResolvedPlanCardStyle {
  const style = branding.planCardStyles?.[planId];
  const gradient =
    style?.gradient && style.gradient.length > 0 ? style.gradient : autoPlanGradient(planId);
  const accent = style?.accent && style.accent.length > 0 ? style.accent : null;
  const textureUrl = style?.textureUrl && style.textureUrl.length > 0 ? style.textureUrl : null;
  // Per-plan effect is OPT-IN. Tariff cards no longer inherit the subscription
  // card's global effect — an unset/`NONE` per-plan effect means static.
  const effect = style?.cardEffect && style.cardEffect !== "NONE" ? style.cardEffect : "NONE";
  const effectProps = style?.cardEffectProps ?? {};
  const effectOpacity =
    typeof style?.cardEffectOpacity === "number" ? style.cardEffectOpacity : 1;
  const contrast = resolveCardContrast(gradient, {
    fallbackBackground: branding.bgSecondary,
    preferredForeground: branding.primaryFg,
    minimumVeilOpacity:
      effect === "NONE"
        ? 0.12
        : 0.18 + Math.min(1, Math.max(0, effectOpacity)) * 0.12,
  });

  let textureImage: string | null = null;
  let textureSize: string | null = null;
  if (!textureUrl && style?.texturePreset) {
    const css = buildTextureCss({
      pattern: style.texturePreset,
      color: accent ?? contrast.foreground,
      background: "transparent",
      scale: 18,
      opacity: 0.5,
    });
    textureImage = css.backgroundImage;
    textureSize = css.backgroundSize;
  }

  return {
    gradient,
    contrast,
    accent,
    textureUrl,
    textureImage,
    textureSize,
    effect,
    effectProps,
    effectOpacity,
  };
}

/* ── colour helpers ─────────────────────────────────────────────────────── */

/**
 * Preserve the operator accent when it passes AA; otherwise move it toward the
 * computed card foreground until it is readable on the post-veil artwork.
 */
export function readablePriceColor(
  hex: string,
  background = "#09090b",
  foreground = "#ffffff",
): string {
  return ensureReadableCardAccent(hex, background, foreground);
}
