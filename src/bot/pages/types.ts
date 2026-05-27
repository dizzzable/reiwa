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
 *
 * Pages do NOT receive the raw `BotConfigCache`; they ask through the
 * `getConfig` callback so swapping the cache for a richer source
 * (e.g. SSE-driven push) stays a single-call change in `bot/main.ts`.
 */
import type { Bot, Context, SessionFlavor } from 'grammy';

import type { AdminClient } from '../../infrastructure/admin-client/index.js';
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
}

export interface PageDeps {
  readonly adminClient: AdminClient | null;
  readonly translator: TranslatorPort;
  readonly userLocale: UserLocaleSyncCache;
  readonly getConfig: () => Promise<BotConfig>;
  readonly urls: BotUrls;
}

export type PageRegistrar = (bot: Bot<BotContext>, deps: PageDeps) => void;
