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
  | "dither"
  | "paperMesh"
  | "paperWarp"
  | "paperGrain"
  | "paperDither"
  | "paperSwirl"
  | "paperMetaballs";

/** Icon colouring strategy for cabinet menu icons (mirrors backend). */
export type IconColorMode = "default" | "theme" | "custom";

/**
 * One per-position card-background slot. Mirrors backend `CardEffectSlot`.
 * Slot N applies to the Nth subscription card (by creation order).
 */
export interface CardEffectSlot {
  /**
   * A slot inherits the global card artwork until the operator explicitly
   * marks it as an override. Older snapshots have no mode and deliberately
   * resolve as `inherit`: themes used to populate every slot automatically,
   * which made later global edits appear to do nothing.
   */
  mode?: "inherit" | "override";
  cardEffect?: CardEffect;
  cardEffectProps?: Record<string, unknown>;
  cardEffectOpacity?: number;
  /**
   * Optional per-slot static card gradient (CSS). Overrides the global
   * `cardGradient` for the Nth subscription card; absent → global gradient.
   */
  cardGradient?: string | null;
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

/**
 * Per-plan tariff-card style (mirrors backend `PlanCardStyle`), keyed by
 * `planId` in `Branding.planCardStyles`. Absent entry → the cabinet derives a
 * deterministic auto gradient from the plan id. `textureUrl` (uploaded image)
 * takes priority over `texturePreset` (built-in pattern).
 */
export interface PlanCardStyle {
  gradient?: string | null;
  accent?: string | null;
  texturePreset?: AppBackgroundTexture | null;
  textureUrl?: string | null;
  /**
   * Optional per-plan animated background effect for the tariff card. `NONE` /
   * absent = static gradient only (the tariff card does NOT inherit the
   * subscription card's global effect). Any other value is a card-effect id.
   */
  cardEffect?: CardEffect | null;
  cardEffectProps?: Record<string, unknown>;
  cardEffectOpacity?: number | null;
}

/** Cabinet navigation destinations (mirrors backend `NAV_DESTINATIONS`). */
export const NAV_DESTINATIONS = [
  "subscriptions",
  "plans",
  "referrals",
  "devices",
  "activity",
  "promo",
  "support",
  "faq",
  "settings",
] as const;
export type NavDestinationId = (typeof NAV_DESTINATIONS)[number];

/** Destinations that are always visible and cannot be hidden. */
export const NAV_ESSENTIAL_DESTINATIONS: readonly NavDestinationId[] = ["subscriptions", "settings"];

/** One bottom-nav entry: a destination id + whether it shows in the nav bar. */
export interface NavItemSetting {
  id: NavDestinationId;
  visible: boolean;
}

export interface SurfaceTheme {
  foreground: string;
  mutedForeground: string;
  surface: string;
  surfaceHigh: string;
  borderSoft: string;
  borderStrong: string;
  surfaceOpacity: number;
  surfaceHighOpacity: number;
  borderSoftOpacity: number;
  borderStrongOpacity: number;
  glassBlurPx: number;
}

export interface CornerRadii {
  cardPx: number;
  itemPx: number;
  pillPx: number;
}

/** A brightness representation of one operator-selected conceptual theme. */
export type BrandingThemeMode = "light" | "dark";
/** Only the operator can lock/unlock the end-user brightness chooser. */
export type BrandingThemeModePolicy = "fixed" | "user-selectable";

/** Foreground policy for the copy drawn on a subscription card. */
export type SubscriptionCardTextMode = "auto" | "light" | "dark" | "custom";

export interface SubscriptionCardText {
  readonly mode: SubscriptionCardTextMode;
  /** Used only by `custom`; accepted values are opaque #rgb/#rrggbb. */
  readonly color: string | null;
}

export const DEFAULT_SUBSCRIPTION_CARD_TEXT: SubscriptionCardText = {
  mode: "auto",
  color: null,
};

/**
 * Optional translucent film drawn above a subscription card's artwork.
 * It is deliberately independent from card effects: toggling glass must not
 * replace, recolour, or otherwise mutate the operator-selected animation.
 */
export interface SubscriptionCardGlass {
  readonly enabled: boolean;
  /** Opaque #rgb/#rrggbb tint used by the glass film and its edge. */
  readonly tint: string;
  readonly opacity: number;
  readonly blurPx: number;
  readonly borderOpacity: number;
}

export const DEFAULT_SUBSCRIPTION_CARD_GLASS: SubscriptionCardGlass = {
  enabled: false,
  tint: "#ffffff",
  opacity: 0.14,
  blurPx: 8,
  borderOpacity: 0.18,
};

/**
 * Resolved visual values for the same conceptual preset. It intentionally has
 * no preset id or brand identity, preventing this payload from becoming a
 * user-facing theme catalogue.
 */
export interface BrandingThemeVariant {
  primary: string;
  primaryFg: string;
  bgPrimary: string;
  bgSecondary: string;
  cardGradient: string;
  cardPattern: string | null;
  /**
   * Optional transport copy for snapshots written after this control existed.
   * Card text remains global and this value is never allowed to override root
   * branding during brightness resolution.
   */
  subscriptionCardText?: SubscriptionCardText;
  cardEffect: CardEffect;
  cardEffectProps: Record<string, unknown>;
  cardEffectOpacity: number;
  cardEffectsByIndex: CardEffectSlot[];
  bgEffect: BgEffect;
  appBackground: AppBackground;
  borderRadius: string;
  cornerRadii: CornerRadii;
  fontFamily: string;
  surfaceTheme: SurfaceTheme;
}

export interface BrandingThemeVariants {
  light: BrandingThemeVariant;
  dark: BrandingThemeVariant;
}

export const DEFAULT_SURFACE_THEME: SurfaceTheme = {
  foreground: "#fafafa",
  mutedForeground: "#a1a1a1",
  surface: "#18181b",
  surfaceHigh: "#27272a",
  borderSoft: "#ffffff",
  borderStrong: "#ffffff",
  surfaceOpacity: 0.7,
  surfaceHighOpacity: 0.8,
  borderSoftOpacity: 0.06,
  borderStrongOpacity: 0.12,
  glassBlurPx: 16,
};

export interface Branding {
  /** Stable WEB Reiwa preset identity; resolved values remain authoritative. */
  themePresetId?: string | null;
  themePresetVersion?: number | null;
  /** Operator policy for the light/dark representation of a concept. */
  themeModePolicy?: BrandingThemeModePolicy;
  /** Locked mode or initial mode for a user-selectable concept. */
  themeDefaultMode?: BrandingThemeMode;
  /** Both resolved representations of that one concept. */
  themeVariants?: BrandingThemeVariants | null;
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
  /** Missing in legacy payloads; resolved as `auto` at card-render time. */
  subscriptionCardText?: SubscriptionCardText;
  /** Missing in legacy payloads; disabled by default at card-render time. */
  subscriptionCardGlass?: SubscriptionCardGlass;
  /** Card watermark glyph preset (DEFAULT = Reiwa mark, NONE = hidden). */
  cardLogo: CardLogoPreset;
  /** Custom card watermark image (same-origin upload, HTTPS, or data image); overrides cardLogo. */
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
  /** Exact geometry; absent snapshots fall back to legacy borderRadius. */
  cornerRadii?: CornerRadii;
  fontFamily: string;
  /** Semantic text/glass tokens. Optional for older operator snapshots. */
  surfaceTheme?: SurfaceTheme;
  /**
   * Per-plan tariff-card styles keyed by `planId`. Absent/empty → the cabinet
   * uses a deterministic auto gradient per plan. Optional so an older payload
   * without the field is handled gracefully.
   */
  planCardStyles?: Record<string, PlanCardStyle>;
  /**
   * Cabinet bottom-navigation layout (ordered destinations + visibility).
   * Absent → the cabinet uses its built-in default nav. Mirrors backend
   * `navItems`.
   */
  navItems?: NavItemSetting[];
  /**
   * Spacing (px) between the bottom-nav buttons. Mirrors backend `navGap`.
   * Absent → the cabinet's default (2).
   */
  navGap?: number;
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
  /**
   * Operator support handle (no leading `@`), injected by the reiwa edge from
   * its `BOT_SUPPORT_USERNAME` env. Used by the Support page to deep-link to
   * the Telegram support account (`t.me/<handle>?text=…`). `null` when unset.
   */
  supportUsername?: string | null;
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
  themePresetId: null,
  themePresetVersion: null,
  themeModePolicy: "fixed",
  themeDefaultMode: "dark",
  themeVariants: null,
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
  subscriptionCardText: DEFAULT_SUBSCRIPTION_CARD_TEXT,
  subscriptionCardGlass: DEFAULT_SUBSCRIPTION_CARD_GLASS,
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
  cornerRadii: {
    cardPx: 24,
    itemPx: 14,
    pillPx: 9999,
  },
  fontFamily: "Geist Variable, system-ui, sans-serif",
  surfaceTheme: DEFAULT_SURFACE_THEME,
  planCardStyles: {},
  navItems: [
    { id: "subscriptions", visible: true },
    { id: "referrals", visible: true },
    { id: "settings", visible: true },
    { id: "plans", visible: false },
    { id: "devices", visible: false },
    { id: "activity", visible: false },
    { id: "promo", visible: false },
    { id: "support", visible: false },
  ],
  navGap: 2,
};

/**
 * Applies a selected brightness without changing the administrator's concept
 * identity or policy fields. Missing/legacy variants are deliberately a
 * no-op, keeping old public-config snapshots fully compatible.
 */
export function resolveBrandingThemeMode(
  branding: Branding,
  mode: BrandingThemeMode,
): Branding {
  const variant = branding.themeVariants?.[mode];
  if (!variant) return branding;

  // Copy the visual subset explicitly. In particular, never spread an
  // untrusted nested payload over the root: a brightness representation must
  // not be able to change the operator-selected preset id, policy, identity,
  // navigation or any user-facing business setting.
  //
  // Subscription-card effects are intentionally not part of the brightness
  // representation. They are an operator-controlled layer: a positional
  // effect wins over the global effect, and both must survive a user's switch
  // between the light and dark renderings of the same concept.
  return {
    ...branding,
    primary: variant.primary,
    primaryFg: variant.primaryFg,
    bgPrimary: variant.bgPrimary,
    bgSecondary: variant.bgSecondary,
    cardGradient: variant.cardGradient,
    cardPattern: variant.cardPattern,
    // This is one global operator decision, never a brightness token. Ignore
    // a stale/corrupt variant copy so a theme switch cannot change it.
    subscriptionCardText: resolveSubscriptionCardText(branding.subscriptionCardText),
    subscriptionCardGlass: resolveSubscriptionCardGlass(branding.subscriptionCardGlass),
    bgEffect: variant.bgEffect,
    appBackground: variant.appBackground,
    borderRadius: variant.borderRadius,
    cornerRadii: variant.cornerRadii,
    fontFamily: variant.fontFamily,
    surfaceTheme: variant.surfaceTheme,
  };
}

/**
 * Browser/Redis snapshots can predate card-text controls. Normalize once at
 * the branding boundary so every card gets stable legacy behaviour.
 */
export function resolveSubscriptionCardText(
  value: SubscriptionCardText | null | undefined,
): SubscriptionCardText {
  if (!value) return DEFAULT_SUBSCRIPTION_CARD_TEXT;
  if (
    value.mode !== "auto" &&
    value.mode !== "light" &&
    value.mode !== "dark" &&
    value.mode !== "custom"
  ) {
    return DEFAULT_SUBSCRIPTION_CARD_TEXT;
  }
  const color =
    typeof value.color === "string" && value.color.trim().length > 0
      ? value.color.trim()
      : null;
  // `custom` is meaningful only with a persisted opaque hex colour. Alpha
  // would make the effective foreground dependent on card artwork and break
  // parity with the live Rezeis preview.
  // Old snapshots sometimes contain `{ mode: "custom", color: null }` from
  // before this field was transactional. Treat it as automatic contrast,
  // rather than producing an accidental dark/light choice at runtime.
  if (value.mode === "custom") {
    return color !== null && isSubscriptionCardTextHex(color)
      ? { mode: "custom", color }
      : DEFAULT_SUBSCRIPTION_CARD_TEXT;
  }
  return {
    mode: value.mode,
    // A colour belongs only to custom mode. Clearing stale values keeps mode
    // switches deterministic across the cached public-config boundary.
    color: null,
  };
}

/**
 * Normalizes the optional global glass layer at the same boundary as card
 * copy. Old cached snapshots therefore render exactly as before (no glass),
 * while malformed values cannot turn into an opaque film over live artwork.
 */
export function resolveSubscriptionCardGlass(
  value: SubscriptionCardGlass | null | undefined,
): SubscriptionCardGlass {
  if (!value || value.enabled !== true) return DEFAULT_SUBSCRIPTION_CARD_GLASS;

  const tint =
    typeof value.tint === "string" && isSubscriptionCardTextHex(value.tint.trim())
      ? value.tint.trim()
      : DEFAULT_SUBSCRIPTION_CARD_GLASS.tint;
  const bounded = (candidate: unknown, fallback: number, maximum: number) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.min(maximum, Math.max(0, candidate))
      : fallback;

  return {
    enabled: true,
    tint,
    opacity: bounded(value.opacity, DEFAULT_SUBSCRIPTION_CARD_GLASS.opacity, 1),
    blurPx: bounded(value.blurPx, DEFAULT_SUBSCRIPTION_CARD_GLASS.blurPx, 40),
    borderOpacity: bounded(
      value.borderOpacity,
      DEFAULT_SUBSCRIPTION_CARD_GLASS.borderOpacity,
      1,
    ),
  };
}

function isSubscriptionCardTextHex(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

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
