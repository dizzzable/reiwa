/**
 * Branding payload shape — mirrors `BrandingSettingsInterface` on the backend.
 * Kept in `types/` so it can be imported by both the runtime provider and
 * any feature that wants to react to the active palette.
 */

export type BgEffect = "NONE" | "MESH" | "PARTICLES" | "NOISE" | "AURORA";

/** Built-in subscription-card watermark glyphs (mirrors backend CARD_LOGO_PRESETS). */
export type CardLogoPreset =
  | "DEFAULT"
  | "NONE"
  | "SHIELD"
  | "BOLT"
  | "GLOBE"
  | "ROCKET"
  | "GHOST"
  | "CROWN"
  | "GEM"
  | "FLAME"
  | "WAVES"
  | "MOUNTAIN"
  | "ORBIT"
  | "HEXAGON";

/** Animated card-background effect ids (mirrors backend CARD_EFFECTS). */
export type CardEffect =
  | "NONE"
  | "aurora"
  | "threads"
  | "softAurora"
  | "rippleGrid"
  | "radar"
  | "plasma"
  | "particles"
  | "liquidChrome"
  | "lineWaves"
  | "iridescence"
  | "grainient"
  | "galaxy"
  | "balatro"
  | "waves"
  | "silk"
  | "beams"
  | "dither";

/** Icon colouring strategy for cabinet menu icons (mirrors backend). */
export type IconColorMode = "default" | "theme" | "custom";

export interface Branding {
  brandName: string;
  logoUrl: string | null;
  primary: string;
  primaryFg: string;
  bgPrimary: string;
  bgSecondary: string;
  cardGradient: string;
  cardPattern: string | null;
  /** Card watermark glyph preset (DEFAULT = Reiwa mark, NONE = hidden). */
  cardLogo: CardLogoPreset;
  /** Custom card watermark image (data: or http(s)); overrides cardLogo. */
  cardLogoUrl: string | null;
  /** Animated effect behind the card (NONE = plain gradient). */
  cardEffect: CardEffect;
  /** Tunable params for the chosen effect (merged over its defaults). */
  cardEffectProps: Record<string, unknown>;
  /** Effect layer opacity (0.05–1). */
  cardEffectOpacity: number;
  bgEffect: BgEffect;
  /** How cabinet menu icons are coloured: default / theme / custom. */
  iconColorMode: IconColorMode;
  /** Per-icon hex colours (used when iconColorMode === "custom"). */
  iconColors: Record<string, string>;
  borderRadius: string;
  fontFamily: string;
}

export interface PublicConfig {
  branding: Branding;
  locales: readonly string[];
  defaultLocale: string;
  /**
   * Operator default currency (Settings → "Валюта по умолчанию"). Display
   * priority only: gateways/prices in this currency are shown first. No
   * conversion is performed.
   */
  defaultCurrency: string;
}

/**
 * SSR / first-paint default. Identical to backend `DEFAULT_BRANDING` so the
 * SPA never flickers between the hardcoded baseline and the network response.
 */
export const DEFAULT_BRANDING: Branding = {
  brandName: "Reiwa",
  logoUrl: null,
  primary: "#22c55e",
  primaryFg: "#0a0a0a",
  bgPrimary: "#0a0a0a",
  bgSecondary: "#171717",
  cardGradient: "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
  cardPattern: null,
  cardLogo: "DEFAULT",
  cardLogoUrl: null,
  cardEffect: "aurora",
  cardEffectProps: {},
  cardEffectOpacity: 1,
  bgEffect: "NONE",
  iconColorMode: "default",
  iconColors: {},
  borderRadius: "rounded-2xl",
  fontFamily: "Geist Variable, system-ui, sans-serif",
};

export const DEFAULT_PUBLIC_CONFIG: PublicConfig = {
  branding: DEFAULT_BRANDING,
  locales: ["ru", "en"] as const,
  defaultLocale: "ru",
  defaultCurrency: "USD",
};
