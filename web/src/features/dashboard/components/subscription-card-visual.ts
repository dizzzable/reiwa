import { brandAuroraStops } from "../../../lib/brand-colors";
import {
  resolveCardContrast,
  type CardContrast,
} from "../../../lib/card-contrast";
import { isKnownCardEffect } from "../../../components/reactbits/card-effect-catalog";
import { resolveCardEffectOutputColors } from "../../../components/reactbits/card-effect-runtime";
import {
  resolveSubscriptionCardGlass,
  resolveSubscriptionCardText,
} from "../../../types/branding";
import type {
  Branding,
  CardEffect,
  CardLogoPreset,
  SubscriptionCardGlass,
  SubscriptionCardText,
} from "../../../types/branding";

/**
 * The complete visual snapshot needed to draw a subscription card.
 *
 * Animation owners resolve this once at the beginning of an operation and
 * keep the object until handoff/removal. That prevents a public-config refresh
 * or a positional slot shift from changing the card halfway through a wipe.
 */
export interface ResolvedSubscriptionCardVisual {
  readonly slotIndex: number | null;
  readonly primary: string;
  readonly primaryFg: string;
  readonly bgSecondary: string;
  readonly contrast: CardContrast;
  readonly cardGradient: string;
  readonly cardPattern: string | null;
  readonly subscriptionCardText: SubscriptionCardText;
  readonly subscriptionCardGlass: SubscriptionCardGlass;
  readonly cardEffect: CardEffect;
  readonly cardEffectProps: Readonly<Record<string, unknown>>;
  readonly cardEffectOpacity: number;
  readonly cardLogo: CardLogoPreset;
  readonly cardLogoUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validSlotIndex(index: number | undefined): number | null {
  return typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0
    ? index
    : null;
}

function resolveCardTextForeground(text: SubscriptionCardText): string | null {
  if (text.mode === "light") return "#ffffff";
  if (text.mode === "dark") return "#0a0a0a";
  return text.mode === "custom" ? text.color : null;
}

/**
 * `brandAuroraStops` intentionally supports the common #rgb/#rrggbb forms.
 * Rezeis also accepts alpha-bearing #rgba/#rrggbbaa values, so strip only the
 * alpha for shader-derived stops while leaving the original primary untouched
 * for CSS accents. This does not inspect operator-owned effect props.
 */
function resolveAuroraStops(primary: string): [string, string, string] {
  const value = primary.trim();
  if (/^#[\da-f]{4}$/i.test(value)) {
    const [r, g, b] = value.slice(1, 4);
    return brandAuroraStops(`#${r}${g}${b}`);
  }
  if (/^#[\da-f]{8}$/i.test(value)) {
    return brandAuroraStops(value.slice(0, 7));
  }
  return brandAuroraStops(value);
}

/**
 * Resolves global + positional Rezeis branding without interpreting arbitrary
 * CSS gradients or effect props. In particular, color arrays are opaque data:
 * they are copied through exactly as supplied by the operator.
 */
export function resolveSubscriptionCardVisual(
  branding: Branding,
  index?: number,
): ResolvedSubscriptionCardVisual {
  const slotIndex = validSlotIndex(index);
  const slot =
    slotIndex === null || !Array.isArray(branding.cardEffectsByIndex)
      ? undefined
      : branding.cardEffectsByIndex[slotIndex];

  // A positional card is a deliberate exception, never a hidden copy left by
  // a concept preset. Missing `mode` is treated as inherit for backwards
  // compatibility with snapshots produced before the explicit control
  // existed. This makes a later global operator edit authoritative again.
  const slotOverridesEffect = slot?.mode === "override";

  const globalProps = isRecord(branding.cardEffectProps)
    ? branding.cardEffectProps
    : {};
  const slotProps = slotOverridesEffect && isRecord(slot?.cardEffectProps)
    ? slot.cardEffectProps
    : undefined;
  const rawProps = slotProps ?? globalProps;

  const globalEffect =
    typeof branding.cardEffect === "string"
      ? branding.cardEffect
      : "NONE";
  const cardEffect =
    slotOverridesEffect && typeof slot?.cardEffect === "string"
      ? slot.cardEffect
      : globalEffect;
  const cardEffectOpacity = finiteNumber(
    slotOverridesEffect ? slot?.cardEffectOpacity : undefined,
    finiteNumber(branding.cardEffectOpacity, 1),
  );

  const primary = nonEmptyString(branding.primary, "var(--brand-primary)");
  const cardEffectProps: Record<string, unknown> =
    cardEffect === "aurora" &&
    rawProps["colorStops"] === undefined
      ? {
          colorStops: resolveAuroraStops(primary),
          amplitude: 1.1,
          blend: 0.55,
          speed: 0.8,
          ...rawProps,
        }
      : { ...rawProps };

  const globalGradient =
    typeof branding.cardGradient === "string" ? branding.cardGradient : "";
  // NOT gated on `slot.mode`, unlike the effect fields above, and that is a
  // decision rather than an oversight: a per-position gradient is its own
  // explicit visual choice, pinned by `subscription-card-motion.test.ts` and
  // stated to the operator in the panel hint ("this choice changes only the
  // animation; the slot gradient is configured separately until reset").
  // Gating it here would silently discard gradients operators have already set.
  const slotGradient =
    typeof slot?.cardGradient === "string" && slot.cardGradient.trim().length > 0
      ? slot.cardGradient
      : null;
  const cardGradient = slotGradient ?? globalGradient;
  const primaryFg = nonEmptyString(
    branding.primaryFg,
    "var(--brand-primary-fg)",
  );
  const bgSecondary = nonEmptyString(
    branding.bgSecondary,
    "var(--brand-bg-secondary)",
  );
  const subscriptionCardText = resolveSubscriptionCardText(
    branding.subscriptionCardText,
  );
  const subscriptionCardGlass = resolveSubscriptionCardGlass(
    branding.subscriptionCardGlass,
  );
  /**
   * WHAT WENT WRONG: the overlay was gated on `cardEffect !== "NONE"` alone.
   * `cardEffect` is open vocabulary — a panel one release ahead can name an
   * effect this bundle has no component for — and for such an id
   * `resolveCardEffectOutputColors` finds no configured colours and returns the
   * DEFAULT aurora palette. So contrast chose the text colour and sized the veil
   * for purple-and-green artwork while the layer drew nothing at all, and the
   * operator's gradient wore a veil for a picture that was not there.
   *
   * An effect that cannot be drawn contributes no overlay, exactly like `NONE`.
   */
  const drawsOverlay = cardEffect !== "NONE" && isKnownCardEffect(cardEffect);
  const effectArtwork = drawsOverlay
    ? resolveCardEffectOutputColors(cardEffect, cardEffectProps).join(" ")
    : null;

  return {
    slotIndex,
    primary,
    primaryFg,
    bgSecondary,
    contrast: resolveCardContrast(cardGradient, {
      fallbackBackground: bgSecondary,
      preferredForeground: primaryFg,
      forcedForeground: resolveCardTextForeground(subscriptionCardText),
      // The contrast resolver still calculates the required WCAG-AA veil from
      // the actual artwork stops. Do not additionally increase it merely
      // because an effect exists: light concepts otherwise receive a white
      // full-card film which visibly drains the shader colours.
      minimumVeilOpacity: 0.12,
      overlayArtwork: effectArtwork,
      overlayOpacity: drawsOverlay ? cardEffectOpacity : 0,
    }),
    cardGradient,
    cardPattern:
      typeof branding.cardPattern === "string" &&
      branding.cardPattern.trim().length > 0 &&
      branding.cardPattern !== "none"
        ? branding.cardPattern
        : null,
    subscriptionCardText,
    subscriptionCardGlass,
    cardEffect: cardEffect as CardEffect,
    cardEffectProps,
    cardEffectOpacity,
    cardLogo:
      typeof branding.cardLogo === "string"
        ? branding.cardLogo
        : "DEFAULT",
    cardLogoUrl:
      typeof branding.cardLogoUrl === "string"
        ? branding.cardLogoUrl
        : null,
  };
}
