/**
 * Page registration contract.
 *
 * Each `bot/pages/<name>.ts` module exports a `register(bot, deps)`
 * function that wires its grammy handlers onto the supplied bot
 * instance. The Wave 3 god-file split replaces the inline
 * `bot.command(...)` / `bot.callbackQuery(...)` chains with a uniform
 * registration call — composition root in `bot/main.ts` simply walks
 * an array of registrars.
 *
 * `PageDeps` carries the dependencies every page is allowed to reach
 * for. It intentionally stays narrow:
 *   - `adminClient` — typed namespace facade (Wave 2)
 *   - `translator`  — TranslatorPort + LocalePackHydrator singleton
 *   - `userLocale`  — sync helper bag for the per-user locale cache
 *   - `getConfig`   — bound BotConfigCache.get
 *   - `urls`        — pre-computed Telegram-safe URLs
 *   - `logger`      — LoggerPort for structured records (best-effort:
 *                     pages that don't need it ignore the field)
 *
 * Pages do NOT receive the raw `BotConfigCache`; they ask through the
 * `getConfig` callback so swapping the cache for a richer source
 * (e.g. SSE-driven push) stays a single-call change in `bot/main.ts`.
 */
import type { Bot, Context, SessionFlavor } from 'grammy';

import type { AdminClient } from '../../infrastructure/admin-client/index.js';
import type { BannerStorePort } from '../../application/ports/banner-store.port.js';
import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';

export interface BotSession {
  step?: string;
}

export type BotContext = Context & SessionFlavor<BotSession>;

export interface UserLocaleSyncCache {
  getSync(userId: number): string;
  setSync(userId: number, lang: string): void;
  hasSync(userId: number): boolean;
}

export interface BotUrls {
  /** Operator-configured public web URL (HTTPS, non-localhost). `null` in dev. */
  readonly publicWebUrl: string | null;
  /** Mini App URL — same as publicWebUrl when configured, else `null`. */
  readonly miniAppUrl: string | null;
  /**
   * Internal admin host base URL (`http://rezeis:8000` in docker, or
   * `https://admin.example.com` in production). Used by the banner
   * resolver to fetch operator-uploaded banner files from
   * `/uploads/bot-banners/...` and re-emit them as Telegram photo
   * uploads.
   */
  readonly rezeisAdminUrl: string | null;
}

export interface PageDeps {
  readonly adminClient: AdminClient | null;
  readonly translator: TranslatorPort;
  readonly userLocale: UserLocaleSyncCache;
  readonly getConfig: () => Promise<BotConfig>;
  readonly urls: BotUrls;
  /**
   * Resolves the per-page banner asset (filesystem or operator URL).
   * `null` when the bot is booted in degraded mode without an assets
   * tree (tests, smoke scripts).
   */
  readonly bannerStore?: BannerStorePort;
  /**
   * Operator support handle from the env (`BOT_SUPPORT_USERNAME`). Pages
   * use this as a fallback when the admin-managed
   * `BotConfig.visual.supportUsername` is unset, so a fresh deploy still
   * gives users a way to reach support.
   */
  readonly envSupportUsername?: string;
  /**
   * Optional structured logger. When omitted (tests, supervised
   * scripts) pages that need to log fall back to console.* — the
   * legacy contract. Production main.ts always supplies a child
   * logger bound to `service: 'bot'`.
   */
  readonly logger?: LoggerPort;
}

export type PageRegistrar = (bot: Bot<BotContext>, deps: PageDeps) => void;
