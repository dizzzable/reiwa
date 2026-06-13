/**
 * Branding namespace — typed branding payload, full SPA bootstrap
 * payload (branding + locales) and the legacy `bot-config` /
 * `public-config` endpoints kept for back-compat.
 */
import type { AdminTransport } from '../transport.js';

export interface BrandingPayload {
  readonly brandName: string;
  readonly logoUrl: string | null;
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
  }>;
  readonly bgEffect: 'NONE' | 'MESH' | 'PARTICLES' | 'NOISE' | 'AURORA';
  readonly borderRadius: string;
  readonly fontFamily: string;
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
