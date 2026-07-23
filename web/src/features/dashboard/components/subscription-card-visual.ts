import { brandAuroraStops } from "../../../lib/brand-colors";
import type {
  Branding,
  CardEffect,
  CardLogoPreset,
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
  readonly cardGradient: string;
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

  const globalProps = isRecord(branding.cardEffectProps)
    ? branding.cardEffectProps
    : {};
  const slotProps = isRecord(slot?.cardEffectProps)
    ? slot.cardEffectProps
    : undefined;
  const rawProps = slotProps ?? globalProps;

  const globalEffect =
    typeof branding.cardEffect === "string"
      ? branding.cardEffect
      : "NONE";
  const cardEffect =
    typeof slot?.cardEffect === "string"
      ? slot.cardEffect
      : globalEffect;

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
  const slotGradient =
    typeof slot?.cardGradient === "string" && slot.cardGradient.trim().length > 0
      ? slot.cardGradient
      : null;

  return {
    slotIndex,
    primary,
    primaryFg: nonEmptyString(
      branding.primaryFg,
      "var(--brand-primary-fg)",
    ),
    bgSecondary: nonEmptyString(
      branding.bgSecondary,
      "var(--brand-bg-secondary)",
    ),
    cardGradient: slotGradient ?? globalGradient,
    cardEffect: cardEffect as CardEffect,
    cardEffectProps,
    cardEffectOpacity: finiteNumber(
      slot?.cardEffectOpacity,
      finiteNumber(branding.cardEffectOpacity, 1),
    ),
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
