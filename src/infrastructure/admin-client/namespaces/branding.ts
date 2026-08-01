/**
 * Branding namespace — typed branding payload, full SPA bootstrap
 * payload (branding + locales) and the legacy `bot-config` /
 * `public-config` endpoints kept for back-compat.
 */
import type { AdminTransport } from '../transport.js';

export interface BrandingPayload {
  readonly themePresetId?: string | null;
  readonly themePresetVersion?: number | null;
  readonly themeModePolicy?: 'fixed' | 'user-selectable';
  readonly themeDefaultMode?: 'light' | 'dark';
  /** Resolved modes of the same operator-selected concept, never a catalogue. */
  readonly themeVariants?: {
    readonly light: BrandingThemeVariantPayload;
    readonly dark: BrandingThemeVariantPayload;
  } | null;
  readonly brandName: string;
  readonly tagline?: string | null;
  readonly logoUrl: string | null;
  /** Square PNG for PWA install (home-screen icon). Falls back to logoUrl. */
  readonly pwaIconUrl?: string | null;
  readonly primary: string;
  readonly primaryFg: string;
  readonly bgPrimary: string;
  readonly bgSecondary: string;
  readonly cardGradient: string;
  readonly cardPattern: string | null;
  readonly cardLogo: string;
  readonly cardLogoUrl: string | null;
  readonly cardEffect: string;
  readonly cardEffectProps: Record<string, unknown>;
  readonly cardEffectOpacity: number;
  readonly cardEffectsByIndex: ReadonlyArray<{
    readonly cardEffect: string;
    readonly cardEffectProps: Record<string, unknown>;
    readonly cardEffectOpacity: number;
    readonly cardGradient?: string | null;
  }>;
  readonly bgEffect: 'NONE' | 'MESH' | 'PARTICLES' | 'NOISE' | 'AURORA';
  readonly appBackground?: {
    readonly kind: 'none' | 'gradient' | 'texture' | 'effect';
    readonly effect: string;
    readonly props: Record<string, unknown>;
    readonly opacity: number;
    readonly gradient: string;
    readonly texture: {
      readonly pattern:
        | 'dots'
        | 'grid'
        | 'diagonal'
        | 'cross'
        | 'waves'
        | 'carbon'
        | 'triangles'
        | 'noise';
      readonly color: string;
      readonly background: string;
      readonly scale: number;
      readonly opacity: number;
    };
  };
  readonly iconColorMode: 'default' | 'theme' | 'custom';
  readonly iconColors: Readonly<Record<string, string>>;
  readonly borderRadius: string;
  readonly cornerRadii?: {
    readonly cardPx: number;
    readonly itemPx: number;
    readonly pillPx: number;
  };
  readonly fontFamily: string;
  readonly surfaceTheme?: {
    readonly foreground: string;
    readonly mutedForeground: string;
    readonly surface: string;
    readonly surfaceHigh: string;
    readonly borderSoft: string;
    readonly borderStrong: string;
    readonly surfaceOpacity: number;
    readonly surfaceHighOpacity: number;
    readonly borderSoftOpacity: number;
    readonly borderStrongOpacity: number;
    readonly glassBlurPx: number;
  };
  readonly planCardStyles?: Readonly<
    Record<
      string,
      {
        readonly gradient?: string | null;
        readonly accent?: string | null;
        readonly texturePreset?: string | null;
        readonly textureUrl?: string | null;
        readonly cardEffect?: string | null;
        readonly cardEffectProps?: Record<string, unknown>;
        readonly cardEffectOpacity?: number | null;
      }
    >
  >;
  readonly navItems?: ReadonlyArray<{
    readonly id:
      | 'subscriptions'
      | 'plans'
      | 'referrals'
      | 'devices'
      | 'activity'
      | 'promo'
      | 'support'
      | 'faq'
      | 'settings';
    readonly visible: boolean;
  }>;
  readonly navGap?: number;
}

interface BrandingThemeVariantPayload {
  readonly primary: string;
  readonly primaryFg: string;
  readonly bgPrimary: string;
  readonly bgSecondary: string;
  readonly cardGradient: string;
  readonly cardPattern: string | null;
  readonly cardEffect: string;
  readonly cardEffectProps: Record<string, unknown>;
  readonly cardEffectOpacity: number;
  readonly cardEffectsByIndex: BrandingPayload['cardEffectsByIndex'];
  readonly bgEffect: string;
  readonly appBackground: NonNullable<BrandingPayload['appBackground']>;
  readonly borderRadius: string;
  readonly cornerRadii: NonNullable<BrandingPayload['cornerRadii']>;
  readonly fontFamily: string;
  readonly surfaceTheme: NonNullable<BrandingPayload['surfaceTheme']>;
}

export interface PublicConfigPayload {
  readonly branding: BrandingPayload;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  /**
   * Operator default currency (Settings → "Валюта по умолчанию"). Display
   * priority only — gateways/prices in this currency are shown first.
   */
  readonly defaultCurrency: string;
  /** Operator's custom icon library (reusable glyphs the cabinet can render). */
  readonly customIcons: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly color: string | null;
  }>;
  /**
   * Whether platform email delivery is configured + enabled. When `false`,
   * the cabinet hides "link email" and email password-recovery affordances.
   */
  readonly emailEnabled?: boolean;
}

export class BrandingNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Returns the bot-config payload (translations map, button styles,
   * channel-subscription settings). Unrelated to the branding payloads
   * below; lives here because it shares the upstream module.
   */
  getBotConfig(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/bot-config');
  }

  /**
   * @deprecated Was incorrectly aliased to `bot-config`. The actual
   * public branding+locale payload lives under `getReiwaPublicConfig()`.
   * Kept only so the SPA build doesn't break during the rename.
   */
  getPublicConfig(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/branding/public-config');
  }

  /**
   * Returns just the typed branding payload (colours, gradients,
   * effects, fonts). Used by surfaces that don't need locale settings
   * (payment-return splash, bot-side renderers).
   */
  getBranding(): Promise<BrandingPayload> {
    return this.transport.request<BrandingPayload>('GET', '/api/internal/branding');
  }

  /**
   * Custom emoji packs (operator-uploaded). Used by the cabinet feed to render
   * `:slug:` tokens as inline images / Lottie animations.
   */
  getCustomEmojiPacks(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/custom-emoji/packs');
  }

  /**
   * Returns the full SPA bootstrap payload — branding + locale defaults
   * derived from rezeis-admin's `.env` (`REZEIS_LOCALES` /
   * `REZEIS_DEFAULT_LOCALE`). Reiwa SPA hits this on the very first
   * render.
   */
  getReiwaPublicConfig(): Promise<PublicConfigPayload> {
    return this.transport.request<PublicConfigPayload>(
      'GET',
      '/api/internal/branding/public-config',
    );
  }
}
