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

/**
 * The name of an animated card background, as the panel published it.
 *
 * Deliberately `string` and not a union of the effects this build ships.
 * rezeis-admin releases on its own cadence, so a name arriving here may belong
 * to an effect the cabinet has not learned yet; the snapshot guard lets it
 * through on purpose, and pretending otherwise in the type would only push the
 * lie one layer down. `isKnownCardEffect` in the effect manifest is where the
 * question "do we have this one?" is actually answered, and it answers it
 * against the components this bundle really contains.
 *
 * `"NONE"` remains meaningful: it is the operator choosing no animation, which
 * is not the same as naming one we cannot draw.
 */
export type CardEffect = string;

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
 * `AppBackgroundSettings`). A `kind` discriminator selects:
 *
 *   - `none`     — the BUILT-IN background: `<NetworkBg>`, the brand-tinted
 *     glows + dot grid + diagonals this cabinet has always drawn behind every
 *     authenticated screen. It is the default and it is NOT a blank colour.
 *     The panel used to call it "None" and describe it as the plain background
 *     colour in three separate places; the picture was never plain, and the
 *     operator who switched the background off saw an empty panel preview and a
 *     patterned cabinet. The name was the lie, so the name changed — the value
 *     stayed `none` and draws exactly what it always drew, because renaming the
 *     stored value would have restyled every existing installation.
 *   - `plain`    — the flat `bgPrimary` colour and nothing else. This is what
 *     "None" used to promise; operators who want it now have it.
 *   - `gradient` — a static CSS gradient,
 *   - `texture`  — a static tiled SVG pattern over a base colour,
 *   - `effect`   — an animated effect. Reuses the card-effect catalog
 *     (`components/reactbits/card-effect-catalog.ts`, with its component map in
 *     `card-effect-manifest.ts`), mounted once at the shell.
 */
export type AppBackgroundKind = "none" | "plain" | "gradient" | "texture" | "effect";

/**
 * Resolve a `kind` that arrived over the wire into one this build can draw.
 *
 * rezeis-admin owns the vocabulary and ships ahead of the cabinet, so an
 * unrecognised kind is a NORMAL event, not corruption — the snapshot guard
 * (`isAppBackgroundKind` in `src/application/ports/public-config-persistence.port.ts`)
 * deliberately lets any short string through rather than discarding the whole
 * branding payload over one decorative field. This is the other half of that
 * contract: everything unknown resolves to `none`, the built-in background this
 * deployment was already showing, so a panel release the cabinet has not caught
 * up with degrades to the familiar default instead of a blank screen.
 *
 * `undefined` also resolves to `none`: pre-`kind` payloads carry only
 * `effect`/`props`/`opacity`, and callers infer `effect` from those themselves
 * before consulting this.
 */
export function resolveAppBackgroundKind(kind: string | undefined): AppBackgroundKind {
  switch (kind) {
    case "plain":
    case "gradient":
    case "texture":
    case "effect":
      return kind;
    default:
      return "none";
  }
}

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
  /**
   * Deliberately `string` rather than `AppBackgroundKind`, for the same reason
   * `CardEffect` is: the panel publishes this name and releases separately, so
   * the value that actually arrives may be a mode this build cannot draw. The
   * snapshot guard lets it through on purpose; narrowing the type here would
   * only move the lie one layer down. `resolveAppBackgroundKind` is where the
   * question "can we draw this one?" is answered, and every consumer asks it.
   */
  kind: string;
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
  /**
   * Per-plan text policy. ABSENT MEANS INHERIT: the card follows the global
   * `Branding.subscriptionCardText`, whose own default is `auto` — the
   * automatic contrast computation every tariff card used before this field
   * existed. Note the deliberate contrast with `cardEffect` directly above,
   * which does NOT inherit; the two fields answer different questions and an
   * unset effect is genuinely "no effect", while an unset text policy is not
   * "no policy".
   */
  text?: PlanCardText | null;
}

/**
 * Per-plan tariff-card text modes: the four subscription-card modes plus
 * `inherit`.
 *
 * `inherit` and `auto` are different values on purpose. `auto` is an explicit
 * per-plan instruction to compute contrast from that card's own artwork, which
 * is the only way to exempt one plan while the global policy is `light`, `dark`
 * or `custom`.
 */
export type PlanCardTextMode = "inherit" | SubscriptionCardTextMode;

export interface PlanCardText {
  readonly mode: PlanCardTextMode;
  /** Used only by `custom`; accepted values are opaque #rgb/#rrggbb. */
  readonly color: string | null;
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
/**
 * Who owns the card gradient. See `Branding.cardGradientSource`.
 */
export type CardGradientSource = "concept" | "custom";

/** Legacy payloads have no source; they behaved as `concept`. */
export function resolveCardGradientSource(
  value: CardGradientSource | undefined,
): CardGradientSource {
  return value === "custom" ? "custom" : "concept";
}

/**
 * Who owns the brand palette. See `Branding.brandPaletteSource`.
 */
export type BrandPaletteSource = "concept" | "custom";

/** Legacy payloads have no source; they behaved as `concept`. */
export function resolveBrandPaletteSource(
  value: BrandPaletteSource | undefined,
): BrandPaletteSource {
  return value === "custom" ? "custom" : "concept";
}

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
 * The plate behind the brand mark on the entry screens. Deliberately a union
 * of the four the panel offers rather than a bare `string`, unlike
 * `CardEffect`: the vocabulary is closed — a plate is painted by CSS this
 * bundle contains, not by a component the panel can ship ahead of us — and
 * `resolveBrandLogo` below resolves an unknown value to `glass`, the look
 * every deployment had before the setting existed.
 */
export type BrandLogoFrame = "glass" | "solid" | "outline" | "none";

/** How the operator's `logoUrl` is presented on the entry screens. */
export interface BrandLogo {
  /** Whole-tile size multiplier, 1–1.75. */
  readonly size: number;
  /** Fraction of the tile the mark fills, 0.4–1. */
  readonly fill: number;
  readonly frame: BrandLogoFrame;
  /**
   * Tile rounding as a percentage of its width, 0–50 — or `null`, meaning
   * "follow the theme's item radius", which is what the tile did before this
   * setting existed and is therefore the default. See
   * `brand-logo-geometry.ts` for the factors.
   */
  readonly radius: number | null;
  /** Brand glow behind the tile, 0–1. */
  readonly glow: number;
}

/**
 * Reproduces the rendering that preceded the setting: an 80 px tile on the form
 * screens and a 96 px one on the splash, their corners following the theme, and
 * a mark filling 58 % of each. One fill ratio serves both, so one of the two
 * moves: 0.58 keeps the splash within a third of a pixel (56 → 55.68) and grows
 * the sign-in mark by 2.4 px (44 → 46.4), which is the direction an operator
 * complaining about a small mark wants anyway.
 */
export const DEFAULT_BRAND_LOGO: BrandLogo = {
  size: 1,
  fill: 0.58,
  frame: "glass",
  radius: null,
  glow: 1,
};

/** Size and weight of the subscription-card watermark. */
export interface CardLogoStyle {
  /** Size multiplier over the card's default watermark box, 0.5–2. */
  readonly scale: number;
  /** Watermark opacity, 0.02–0.4. */
  readonly opacity: number;
}

export const DEFAULT_CARD_LOGO_STYLE: CardLogoStyle = {
  scale: 1,
  opacity: 0.1,
};

const BRAND_LOGO_FRAMES: ReadonlySet<string> = new Set([
  "glass",
  "solid",
  "outline",
  "none",
]);

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/**
 * Resolves a `brandLogo` payload, tolerating absence entirely: a cabinet
 * talking to a panel older than this setting receives nothing here, and must
 * render exactly as it did before.
 */
export function resolveBrandLogo(value: unknown): BrandLogo {
  if (typeof value !== "object" || value === null) return DEFAULT_BRAND_LOGO;
  const raw = value as Record<string, unknown>;
  return {
    size: clampNumber(raw["size"], 1, 1.75, DEFAULT_BRAND_LOGO.size),
    fill: clampNumber(raw["fill"], 0.4, 1, DEFAULT_BRAND_LOGO.fill),
    frame:
      typeof raw["frame"] === "string" && BRAND_LOGO_FRAMES.has(raw["frame"])
        ? (raw["frame"] as BrandLogoFrame)
        : DEFAULT_BRAND_LOGO.frame,
    // `null` is a value here, not an absence: it is the operator saying
    // "follow the theme". Only a usable number overrides it.
    radius:
      typeof raw["radius"] === "number" && Number.isFinite(raw["radius"])
        ? Math.min(50, Math.max(0, raw["radius"]))
        : null,
    glow: clampNumber(raw["glow"], 0, 1, DEFAULT_BRAND_LOGO.glow),
  };
}

export function resolveCardLogoStyle(value: unknown): CardLogoStyle {
  if (typeof value !== "object" || value === null) return DEFAULT_CARD_LOGO_STYLE;
  const raw = value as Record<string, unknown>;
  return {
    scale: clampNumber(raw["scale"], 0.5, 2, DEFAULT_CARD_LOGO_STYLE.scale),
    opacity: clampNumber(raw["opacity"], 0.02, 0.4, DEFAULT_CARD_LOGO_STYLE.opacity),
  };
}

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
  /**
   * How the mark above is presented on the entry screens. Absent from any
   * payload written by a panel older than the setting; `resolveBrandLogo`
   * turns that absence into the previous rendering.
   */
  brandLogo?: BrandLogo;
  primary: string;
  primaryFg: string;
  bgPrimary: string;
  bgSecondary: string;
  /**
   * Where the brand palette — `primary`, `primaryFg`, `bgPrimary`,
   * `bgSecondary` AND the whole of `surfaceTheme` — comes from, and therefore
   * who wins a disagreement between the root values and the per-brightness
   * variants.
   *
   *   - `concept` — the operator picked a concept, and the concept's own
   *     light/dark palettes apply. Producing a deliberately different palette
   *     per brightness is what a concept is for.
   *   - `custom` — the operator set a colour by hand in the panel's colour or
   *     surfaces tab. The root values win everywhere and no variant may
   *     override them.
   *
   * Same defect as `cardGradientSource` below, in the same shape: the panel
   * wrote the colour to the root only, the variant overwrote it on every read,
   * and the operator saw their colour in the panel preview and nowhere else.
   * "Root always wins" — the answer used for the font and the corner radii —
   * is wrong here for the reason it was wrong for the gradient: a concept
   * legitimately ships two palettes, and collapsing them would delete that.
   *
   * The colours move as ONE unit deliberately. `primary`/`primaryFg` is a
   * contrast pair and `bgPrimary`/`bgSecondary` a surface pair; taking two from
   * the operator and two from the concept yields a palette neither of them
   * designed. The panel writes all four through the same control, so there is
   * no per-colour ownership for a per-colour flag to express.
   *
   * `surfaceTheme` joined that unit rather than getting a marker of its own,
   * and this is the one boundary here worth defending. It carries the
   * FOREGROUND colours; `bgPrimary`/`bgSecondary` carry the backgrounds behind
   * them. Give the two halves separate owners and a detached palette composes
   * text and background from different designs — the operator's dark
   * background under the light concept's dark text, which is not a degraded
   * result but an unreadable one. A per-brightness rule for surfaces alone
   * cannot avoid that, because the disagreement is between the two markers,
   * not inside either. One marker, one contrast decision.
   *
   * Absent in legacy payloads and resolved as `concept`, which reproduces the
   * previous behaviour for installs that never touched the control.
   */
  brandPaletteSource?: BrandPaletteSource;
  cardGradient: string;
  cardPattern: string | null;
  /**
   * Where the card gradient comes from, and therefore who wins a disagreement
   * between the root value and the per-brightness variants.
   *
   *   - `concept` — the operator picked a concept, and the concept's own
   *     light/dark gradients apply. That difference is the concept's whole
   *     point: it generates a distinct palette per brightness.
   *   - `custom` — the operator wrote their own gradient. The root value wins
   *     everywhere and no variant may override it.
   *
   * Before this existed, one field served both meanings and they could not be
   * told apart, so the variant always won: an operator saved a gradient, the
   * cabinet went on drawing the concept's, forever. Absent in legacy payloads
   * and resolved as `concept`, which reproduces the previous behaviour for
   * installs that never touched the control.
   */
  cardGradientSource?: CardGradientSource;
  /** Missing in legacy payloads; resolved as `auto` at card-render time. */
  subscriptionCardText?: SubscriptionCardText;
  /** Missing in legacy payloads; disabled by default at card-render time. */
  subscriptionCardGlass?: SubscriptionCardGlass;
  /** Card watermark glyph preset (DEFAULT = Reiwa mark, NONE = hidden). */
  cardLogo: CardLogoPreset;
  /** Custom card watermark image (same-origin upload, HTTPS, or data image); overrides cardLogo. */
  cardLogoUrl: string | null;
  /** Size and weight of that watermark; absent in legacy payloads. */
  cardLogoStyle?: CardLogoStyle;
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
  brandLogo: DEFAULT_BRAND_LOGO,
  primary: "#22c55e",
  primaryFg: "#0a0a0a",
  bgPrimary: "#0a0a0a",
  bgSecondary: "#171717",
  brandPaletteSource: "concept",
  cardGradient: "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
  // Stated rather than left to `resolveCardGradientSource`, which resolves the
  // same value from `undefined`. The backend default and the panel's form draft
  // both spell it out, and `brandPaletteSource` above already does here; the
  // one field that did not made this list read as if it had a different rule.
  cardGradientSource: "concept",
  cardPattern: null,
  subscriptionCardText: DEFAULT_SUBSCRIPTION_CARD_TEXT,
  subscriptionCardGlass: DEFAULT_SUBSCRIPTION_CARD_GLASS,
  cardLogo: "DEFAULT",
  cardLogoUrl: null,
  cardLogoStyle: DEFAULT_CARD_LOGO_STYLE,
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
  const gradientSource = resolveCardGradientSource(branding.cardGradientSource);
  const paletteSource = resolveBrandPaletteSource(branding.brandPaletteSource);

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
    // The variant wins ONLY while the palette belongs to a concept.
    //
    // These four lines used to run unconditionally, which is why a colour the
    // operator typed in the panel never reached the cabinet: it landed on the
    // root and was overwritten here on every read, forever. Fourth appearance
    // of the identical defect — see the font and the corner radii below, and
    // the card gradient just after this.
    //
    // It cannot be fixed the way the font was. "Root always wins" is right for
    // a font because a font has no per-brightness meaning at all; a palette
    // has one exactly when a concept supplies it, and a concept generating a
    // distinct palette per brightness is the entire point of a concept. So the
    // question is WHOSE the palette is, not which side to pick — the same
    // answer the gradient already needed.
    //
    // The four colours move together on purpose; `Branding.brandPaletteSource`
    // records why splitting them composes a palette nobody designed.
    //
    // `surfaceTheme` moves with them, and that boundary is load-bearing rather
    // than tidy. Its previous line — `surfaceTheme: variant.surfaceTheme`,
    // unconditional — argued that text and glass colours are the one thing that
    // genuinely differs between a light and a dark rendering. True, and still
    // true while the palette belongs to a concept. But it stopped being the
    // whole story the moment the palette above could detach, because
    // `bgPrimary`/`bgSecondary` and `surfaceTheme.foreground` are the two halves
    // of ONE contrast decision:
    //
    //   operator pins a dark background  → root wins for bgSecondary
    //   user selects the light rendering → variant wins for foreground
    //   result: the light variant's DARK text on the operator's DARK background
    //
    // Unreadable, and reachable with no exotic input — it is what a detached
    // palette produced for every install between that fix and this one. A
    // narrower rule for surfaces (opacities only, or "detach only while the
    // brightness policy is fixed") would leave that state exactly as it is: the
    // hazard is not that surfaces detach too freely, it is that ownership was
    // split down the middle of a contrast pair. So there is one marker for the
    // whole colour system, and the pair can never disagree about whose it is.
    //
    // The cost is stated plainly: an operator who hand-picks colours gets those
    // colours in BOTH renderings, and the brightness toggle stops repainting
    // the palette. That is what "these are my colours" means, and it is the
    // safe direction — a contrast the operator composed themselves, rather than
    // one assembled from two designs that never met.
    ...(paletteSource === "custom"
      ? {
          primary: branding.primary,
          primaryFg: branding.primaryFg,
          bgPrimary: branding.bgPrimary,
          bgSecondary: branding.bgSecondary,
          // `?? variant` is not defensive padding. `Branding.surfaceTheme` is
          // OPTIONAL — a payload predating the field is meant to be handled
          // gracefully — while the variant's copy is required. Taking the root
          // unconditionally therefore made this resolver able to return
          // `undefined` where the line it replaced always returned a value, for
          // any install whose stored branding predates surfaces. Detaching says
          // the operator's colours win; it cannot conjure colours they never
          // set, and the concept's are the only ones that exist in that case.
          surfaceTheme: branding.surfaceTheme ?? variant.surfaceTheme,
        }
      : {
          primary: variant.primary,
          primaryFg: variant.primaryFg,
          bgPrimary: variant.bgPrimary,
          bgSecondary: variant.bgSecondary,
          surfaceTheme: variant.surfaceTheme,
        }),
    // The variant wins ONLY while the gradient belongs to a concept.
    //
    // A concept generates a deliberately different palette for each
    // brightness, so taking the variant is correct there. But the same line
    // used to run unconditionally, which is why an operator's own gradient
    // never reached the cabinet: it landed on the root and was overwritten
    // here on every read, forever — the identical defect already fixed below
    // for the font and the corner radii, and for the same reason. The
    // difference is that a font has no per-brightness meaning at all, whereas
    // a card gradient has one exactly when a concept supplies it. So this is
    // resolved by knowing WHOSE the gradient is, not by picking a side.
    ...(gradientSource === "custom"
      ? { cardGradient: branding.cardGradient, cardPattern: branding.cardPattern }
      : { cardGradient: variant.cardGradient, cardPattern: variant.cardPattern }),
    // This is one global operator decision, never a brightness token. Ignore
    // a stale/corrupt variant copy so a theme switch cannot change it.
    subscriptionCardText: resolveSubscriptionCardText(branding.subscriptionCardText),
    subscriptionCardGlass: resolveSubscriptionCardGlass(branding.subscriptionCardGlass),
    // These two are per-brightness with no marker of their own, and that is not
    // an oversight in the shape of the four cases above. The panel has no
    // control for `bgEffect` at all — only a preset writes it — so there is no
    // operator value here for a variant to overwrite. `appBackground` does have
    // one, and its ownership is resolved by a MIRROR instead of a marker: a
    // direct root edit is copied into both snapshots, by the panel as the
    // operator makes it and by the admin API again on save
    // (`mergeBrandingSettings`, `hasDirectVisualPatch`). So what arrives here is
    // already the operator's own background whenever they set one, and the
    // concept's per-brightness backgrounds still apply while they have not.
    bgEffect: variant.bgEffect,
    appBackground: variant.appBackground,
    // Typeface and geometry are NOT brightness tokens, and taking them from the
    // variant is why the operator's font never reached the cabinet.
    //
    // The variants are a snapshot of the concept preset, written once when the
    // preset is applied, and every global the operator can still edit afterwards
    // is mirrored back into them by the panel — the card gradient and pattern,
    // the card text, the brand palette, the surfaces, the app background. The
    // font and the corner radii are the exception, because there is nothing
    // per-mode about them: the panel offers ONE font dropdown and ONE set of
    // radius sliders, not one per brightness, and the opposite-brightness
    // builder copies all three across unchanged. So every later edit landed on
    // the root and was then overwritten here by the preset's original value, on
    // every read, forever.
    //
    // Root wins for exactly the same reason `subscriptionCardText` above does:
    // it is one global operator decision, and a brightness switch must not be
    // able to change it. Fixing it on this side rather than by teaching the
    // panel a fourth mirror also repairs installs whose variants already hold
    // the stale copy — there is nothing to migrate.
    //
    // `surfaceTheme` used to be resolved here, unconditionally from the variant.
    // It now travels with the brand palette above, because the two are one
    // contrast decision — see the note there for what splitting them produced.
    borderRadius: branding.borderRadius,
    cornerRadii: branding.cornerRadii,
    fontFamily: branding.fontFamily,
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
 * The effective text policy for ONE tariff card.
 *
 * PRECEDENCE — the same baseline/override rule the positional card slots use:
 *
 *   1. an explicit per-plan mode (`auto` / `light` / `dark` / a usable
 *      `custom`) wins for that card alone;
 *   2. anything else falls back to the global `subscriptionCardText`;
 *   3. whose own default is `auto`, i.e. the automatic contrast computation
 *      every tariff card performed before this field existed.
 *
 * Step 2 covers four inputs that all mean "no per-plan decision", and they are
 * collapsed here rather than at the call site so there is exactly one place to
 * read:
 *
 *   - `undefined`/`null` — the shape of EVERY entry stored before this control
 *     shipped. This is the path that guarantees an untouched installation keeps
 *     rendering exactly as it does today;
 *   - `inherit` — the operator said so;
 *   - a mode this bundle does not recognise — a panel one release ahead may
 *     name a policy this code cannot honour. Inheriting is the conservative
 *     reading, and unlike the snapshot guard this cannot be a hard failure: see
 *     the `isEffectId` note in `public-config-persistence.port.ts` for what
 *     treating open vocabulary as a closed set cost last time;
 *   - `custom` with no usable opaque colour — the same defect
 *     `resolveSubscriptionCardText` guards below. Falling back to the global
 *     policy (rather than to `auto`) keeps the card on the operator's most
 *     recent workable decision.
 */
export function resolvePlanCardText(
  value: PlanCardText | null | undefined,
  global: SubscriptionCardText | null | undefined,
): SubscriptionCardText {
  const inherited = resolveSubscriptionCardText(global);
  if (!value || value.mode === "inherit") return inherited;
  if (value.mode === "auto" || value.mode === "light" || value.mode === "dark") {
    // A colour belongs to `custom` alone; drop any stale one, exactly as the
    // global normalizer does, so the two cards cannot diverge.
    return { mode: value.mode, color: null };
  }
  if (value.mode === "custom") {
    // Rebuilt rather than passed through: `PlanCardText` is the wider type, and
    // reusing the global normalizer is what keeps the accepted colour forms
    // (opaque #rgb/#rrggbb, trimmed) identical on both cards.
    const normalized = resolveSubscriptionCardText({
      mode: "custom",
      color: value.color,
    });
    return normalized.mode === "custom" ? normalized : inherited;
  }
  return inherited;
}

/**
 * The literal foreground an operator decision forces, or `null` when the card
 * computes its own contrast (`auto`).
 *
 * Shared by the subscription card and the tariff card BECAUSE they must agree:
 * a tariff card inherits this decision from the subscription card, so two
 * copies of the light/dark hex pair would let "inherit" quietly mean something
 * different on each card.
 */
export function resolveCardTextForeground(
  text: SubscriptionCardText,
): string | null {
  if (text.mode === "light") return "#ffffff";
  if (text.mode === "dark") return "#0a0a0a";
  return text.mode === "custom" ? text.color : null;
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
