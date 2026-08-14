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
import { isKnownCardEffect } from "@/components/reactbits/card-effect-catalog";
import { resolveCardEffectOutputColors } from "@/components/reactbits/card-effect-runtime";
import { buildTextureCss } from "@/lib/app-texture";
import {
  ensureReadableCardAccent,
  resolveCardContrast,
  type CardContrast,
} from "@/lib/card-contrast";
import {
  resolveCardTextForeground,
  resolvePlanCardText,
} from "@/types/branding";
import type { Branding, SubscriptionCardText } from "@/types/branding";

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
  /**
   * The text policy this card ended up on, already resolved through
   * per-plan → global → `auto`. Exposed for the same reason the subscription
   * card exposes its own: it is what the card was told, as opposed to what the
   * contrast resolver made of it.
   */
  readonly text: SubscriptionCardText;
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
  /**
   * WHAT WENT WRONG, three times over. Each time the same way: this decided
   * that an effect was on the card when the card was not going to draw one.
   *
   * The tariff card layers the same animated effect over its gradient as the
   * subscription card does, but passed contrast only the gradient. Text colour
   * and veil were therefore chosen for artwork the operator had covered up: an
   * opaque white effect over a dark plan gradient still produced white text.
   * The subscription card has fed the effect's own output colours in since it
   * grew the same overlay; this brings the two into line.
   *
   * And the veil floor was raised for any effect id that was not `NONE`.
   * `cardEffect` is open vocabulary, so an id from a panel one release ahead —
   * one this bundle cannot draw — both fabricated a default aurora palette here
   * and darkened the card for it. Nothing that cannot be drawn contributes
   * anything: no colours, no extra veil.
   *
   * And `textureUrl` reopened it. A per-plan uploaded image is the deliberate
   * art for that card, so `tariff-card.tsx` renders the image and suppresses
   * the effect outright (`showEffect = effect !== "NONE" && !visual.textureUrl`).
   * This did not know that, so a plan with BOTH an image and an effect got dark
   * text and a raised veil sized for an animation that was never mounted. The
   * two conditions have to agree; if that suppression rule ever moves, this
   * moves with it.
   *
   * Note the asymmetry with `texturePreset` below, which is deliberate: a
   * preset grain is a subtle overlay that sits ON TOP of a live effect, so it
   * suppresses nothing and is not consulted here.
   */
  const drawsOverlay =
    effect !== "NONE" && isKnownCardEffect(effect) && textureUrl === null;
  const clampedEffectOpacity = Math.min(1, Math.max(0, effectOpacity));
  /**
   * The operator's text decision for THIS card: the per-plan override if there
   * is one, otherwise the global subscription-card policy. See
   * `resolvePlanCardText` for the full precedence and why absence means
   * inherit rather than `auto`.
   *
   * The invariant that has to survive every future edit here: an installation
   * that has touched neither control has no `text` key on any entry and a
   * global policy of `auto`, so `forcedForeground` is `null` — and a `null`
   * forced foreground is exactly what `resolveCardContrast` does when the
   * option is absent (it parses `options.forcedForeground ?? ""`, which yields
   * no colour). The call below is therefore identical to the one that shipped,
   * option for option, for every installation that has not opted in.
   *
   * `preferredForeground` stays where it is and keeps its old meaning: it is a
   * tiebreaker for the automatic path, not a decision, and it is ignored
   * outright once a foreground is forced.
   */
  const text = resolvePlanCardText(style?.text, branding.subscriptionCardText);
  const contrast = resolveCardContrast(gradient, {
    fallbackBackground: branding.bgSecondary,
    preferredForeground: branding.primaryFg,
    forcedForeground: resolveCardTextForeground(text),
    minimumVeilOpacity: drawsOverlay ? 0.18 + clampedEffectOpacity * 0.12 : 0.12,
    overlayArtwork: drawsOverlay
      ? resolveCardEffectOutputColors(effect, effectProps).join(" ")
      : null,
    overlayOpacity: drawsOverlay ? clampedEffectOpacity : 0,
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
    text,
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
