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

/**
 * One per-position card-background slot. Mirrors backend `CardEffectSlot`.
 * Slot N applies to the Nth subscription card (by creation order).
 */
export interface CardEffectSlot {
  cardEffect: CardEffect;
  cardEffectProps: Record<string, unknown>;
  cardEffectOpacity: number;
}

/**
 * Site-wide app background — rendered behind the whole cabinet (mirrors backend
 * `AppBackgroundSettings`). A `kind` discriminator selects a plain colour
 * (`none`), a static gradient, a static tiled texture, or an animated effect.
 * Reuses the card-effect registry for `effect`, mounted once at the shell.
 */
export type AppBackgroundKind = "none" | "gradient" | "texture" | "effect";

export type AppBackgroundTexture =
  | "dots"
  | "grid"
  | "diagonal"
  | "cross"
  | "waves"
  | "carbon"
  | "triangles"
  | "noise";

export interface AppBackgroundTextureSettings {
  pattern: AppBackgroundTexture;
  color: string;
  background: string;
  scale: number;
  opacity: number;
}

export interface AppBackground {
  kind: AppBackgroundKind;
  /** Animated effect (kind === "effect"). */
  effect: CardEffect;
  props: Record<string, unknown>;
  opacity: number;
  /** Static CSS gradient (kind === "gradient"). */
  gradient: string;
  /** Static tiled texture (kind === "texture"). */
  texture: AppBackgroundTextureSettings;
}

export interface Branding {
  brandName: string;
  /** Optional short subtitle shown on the splash + in-app loader. */
  tagline?: string | null;
  logoUrl: string | null;
  /** Square PNG for PWA install (home-screen icon). Falls back to logoUrl. */
  pwaIconUrl?: string | null;
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
  /**
   * Per-position card backgrounds. Slot N styles the Nth subscription card
   * (ordered by subscription creation date) for ALL users. Subscriptions
   * beyond the configured slots fall back to the global `cardEffect`.
   */
  cardEffectsByIndex: CardEffectSlot[];
  bgEffect: BgEffect;
  /**
   * Site-wide animated app background (NONE = plain bgPrimary colour).
   * Optional so an older payload without the field is handled gracefully.
   */
  appBackground?: AppBackground;
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
  /** Operator's custom icon library (reusable glyphs the cabinet can render). */
  customIcons: CustomIcon[];
  /**
   * Telegram bot username (no leading `@`), injected by the reiwa edge from
   * its `BOT_USERNAME` env. Used to build `t.me/<bot>?start=<ref>` referral /
   * invite links. `null` when not configured.
   */
  botUsername?: string | null;
  /** Platform-branding texts (project name, web page title). */
  platformBranding?: {
    projectName: string | null;
    webTitle: string | null;
  };
  /**
   * Whether platform email delivery is configured + enabled. When `false`,
   * the cabinet hides email password-recovery and "link email" affordances —
   * there's no way to deliver a code, so offering them would be a dead end.
   */
  emailEnabled?: boolean;
}

/** One operator-uploaded custom icon. Mirrors the backend `CustomIconInterface`. */
export interface CustomIcon {
  id: string;
  name: string;
  /** Public URL relative to the admin host (`/uploads/icons/<file>`). */
  url: string;
  /** Optional hex tint applied via a CSS mask; `null` keeps the icon's own colours. */
  color: string | null;
}

/**
 * SSR / first-paint default. Identical to backend `DEFAULT_BRANDING` so the
 * SPA never flickers between the hardcoded baseline and the network response.
 */
export const DEFAULT_BRANDING: Branding = {
  brandName: "Reiwa",
  tagline: null,
  logoUrl: null,
  pwaIconUrl: null,
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
  cardEffectsByIndex: [],
  bgEffect: "NONE",
  appBackground: {
    kind: "none",
    effect: "NONE",
    props: {},
    opacity: 1,
    gradient: "linear-gradient(135deg, #0a0a0a 0%, #171717 100%)",
    texture: {
      pattern: "dots",
      color: "#22c55e",
      background: "#0a0a0a",
      scale: 24,
      opacity: 0.15,
    },
  },
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
  customIcons: [],
  botUsername: null,
  platformBranding: { projectName: null, webTitle: null },
  emailEnabled: false,
};
