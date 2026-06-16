/**
 * In-memory bot-config cache with translator hydration side-effect.
 *
 * Wave 3 extracted this from the bot god-file. The bot polls
 * `AdminClient.getBotConfig()` (Wave 6 will replace the polling with
 * an SSE pull) and caches the result for `ttlMs` so every command
 * doesn't trigger a fresh HTTP round-trip.
 *
 * Translator hydration is intentionally done here, not in the
 * caller: every refresh hands the operator-managed `translations`
 * map to the injected `LocalePackHydrator` so `t()` calls downstream
 * see fresh labels without an extra reload step.
 *
 * Constructor injects:
 *   - a `getBotConfig` callback (the bound AdminClient method)
 *   - a `LocalePackHydrator` (the Translator singleton or a stub in
 *     tests)
 *   - the default config used as a fallback when admin is unreachable
 *     and the cache is empty
 *   - optional ttlMs override and LoggerPort
 */
import type { LocalePackHydrator } from '../../application/ports/translator.port.js';
import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { ConfigPersistencePort } from '../../application/ports/config-persistence.port.js';

import type { BotConfig } from './types.js';

/**
 * Subset of `BotConfig` we look up — typed loosely so the cache stays
 * agnostic to upstream contract drift. The cache forwards whatever
 * shape it receives to the consumer; only the `translations` field is
 * intercepted (and even that is treated as best-effort).
 */
type RawBotConfig = BotConfig & { readonly translations?: Record<string, string> };

export interface BotConfigCacheOptions {
  /** Bound `AdminClient.getBotConfig.bind(adminClient)` or a stub. */
  readonly fetcher: () => Promise<unknown>;
  readonly hydrator: LocalePackHydrator;
  readonly fallback: BotConfig;
  readonly ttlMs?: number;
  readonly logger?: LoggerPort;
  /**
   * Optional durable last-known-good store (Workstream 4). When present:
   *   - every successful fetch is persisted (fire-and-forget)
   *   - a cold-start fetch failure seeds the returned config from the
   *     store instead of the hardcoded `fallback`
   * Omitted (tests / no Redis) → behaves exactly as before.
   */
  readonly persistence?: ConfigPersistencePort;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  readonly data: BotConfig;
  readonly fetchedAt: number;
}

export class BotConfigCache {
  private readonly fetcher: () => Promise<unknown>;
  private readonly hydrator: LocalePackHydrator;
  private readonly fallback: BotConfig;
  private readonly ttlMs: number;
  private readonly logger: LoggerPort | undefined;
  private readonly persistence: ConfigPersistencePort | undefined;
  private entry: CacheEntry | null = null;

  constructor(options: BotConfigCacheOptions) {
    this.fetcher = options.fetcher;
    this.hydrator = options.hydrator;
    this.fallback = options.fallback;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = options.logger;
    this.persistence = options.persistence;
  }

  /**
   * Returns a fresh-or-cached config. Refreshes when the cache is
   * empty or older than `ttlMs`. Refresh failures fall back to:
   *   - the previously cached entry (degraded mode), or
   *   - the constructor `fallback` if nothing has ever been cached.
   *
   * Translator overrides are pushed via `hydrator.setOverrides()` on
   * every successful refresh, so admin edits propagate within `ttlMs`
   * without an explicit cache-bust.
   */
  async get(): Promise<BotConfig> {
    if (this.entry !== null && Date.now() - this.entry.fetchedAt < this.ttlMs) {
      return this.entry.data;
    }
    try {
      const raw = (await this.fetcher()) as RawBotConfig;
      this.entry = { data: raw, fetchedAt: Date.now() };
      // Hydrate translator overrides from the operator-managed
      // `translations` map. Best-effort — a malformed payload
      // shouldn't block the cache.
      try {
        this.hydrator.setOverrides(raw.translations);
      } catch (err: unknown) {
        this.logger?.warn(
          { err },
          'BotConfigCache: hydrator.setOverrides threw',
        );
      }
      // Persist the fresh snapshot as last-known-good (fire-and-forget).
      // A store outage must not slow down or fail the hot path.
      void this.persistence?.save(raw).catch((err: unknown) => {
        this.logger?.warn({ err }, 'BotConfigCache: persistence.save threw');
      });
      return this.entry.data;
    } catch (err: unknown) {
      this.logger?.warn(
        { err },
        'BotConfigCache: refresh failed; serving stale or fallback',
      );
      if (this.entry !== null) return this.entry.data;
      // Cold start with a failed upstream fetch: prefer the persisted
      // last-known-good config (correct branding + banner) over the
      // hardcoded default. We intentionally do NOT set `entry`, so the
      // cache keeps retrying the fetcher until upstream recovers.
      const persisted = await this.loadPersisted();
      if (persisted !== null) return persisted;
      return this.fallback;
    }
  }

  /**
   * Best-effort read of the durable last-known-good snapshot, hydrating
   * the translator from it so localized copy survives a cold start too.
   * Returns `null` when no store is configured, the store is empty, or
   * the load fails.
   */
  private async loadPersisted(): Promise<BotConfig | null> {
    if (this.persistence === undefined) return null;
    try {
      const persisted = await this.persistence.load();
      if (persisted === null) return null;
      try {
        this.hydrator.setOverrides(
          (persisted as RawBotConfig).translations,
        );
      } catch {
        // ignore hydrator failure — the config itself is still usable
      }
      this.logger?.info(
        {},
        'BotConfigCache: seeded from persisted last-known-good config',
      );
      return persisted;
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'BotConfigCache: persistence.load threw');
      return null;
    }
  }

  /** Test seam — drop the cached entry so the next `get()` re-fetches. */
  reset(): void {
    this.entry = null;
  }

  /**
   * Stamp a Telegram-resolved banner `file_id` into the live config
   * snapshot and re-persist it, so a custom banner survives a reboot and
   * can be re-sent via `file_id` without re-downloading from rezeis
   * (Workstream 4). Best-effort and a no-op unless the current snapshot's
   * `bannerUrl` matches the supplied `bannerUrl` (guards against stamping
   * a stale id after the operator swaps the banner). Mutates a shallow
   * copy so the cached reference identity changes for downstream readers.
   */
  stampBannerFileId(bannerUrl: string, fileId: string): void {
    const current = this.entry?.data;
    if (current === undefined) return;
    if (current.visual.bannerUrl !== bannerUrl) return;
    if (current.visual.bannerFileId === fileId) return;
    const next: BotConfig = {
      ...current,
      visual: { ...current.visual, bannerFileId: fileId },
    };
    this.entry = { data: next, fetchedAt: this.entry?.fetchedAt ?? Date.now() };
    void this.persistence?.save(next).catch((err: unknown) => {
      this.logger?.warn(
        { err },
        'BotConfigCache: persistence.save (banner stamp) threw',
      );
    });
  }

  /**
   * Operator-driven cache bust. Same wire as `reset()` but with an
   * explicit log line so an operator inspecting bot logs can correlate
   * the invalidate event with their save action in the admin SPA.
   *
   * Returns the fresh config (so the caller can ack with the latest
   * payload) or `null` when the upstream refresh fails — the cache
   * keeps serving stale data in that case rather than going dark.
   */
  async forceInvalidate(reason: string): Promise<BotConfig | null> {
    this.logger?.info(
      { reason, hadCachedEntry: this.entry !== null },
      'BotConfigCache: forced invalidate',
    );
    this.entry = null;
    try {
      return await this.get();
    } catch {
      return null;
    }
  }
}

/**
 * Default reiwa bot config, mirrored from the rezeis-admin
 * `BotConfigModule.OnApplicationBootstrap` seed (Wave 7). Used as a
 * fallback when the admin API is unreachable AND the cache is empty.
 *
 * Keep this in sync with `DEFAULT_BUTTONS` on the admin side; the bot
 * keyboard renders correctly even before the operator runs the seed.
 */
export const DEFAULT_BOT_CONFIG: BotConfig = {
  buttons: [
    { id: 'cabinet', emoji: '', label: 'Мой кабинет', visible: true, order: 0, style: 'primary', onePerRow: true },
    { id: 'invite', emoji: '', label: 'Пригласить', visible: true, order: 1, style: 'default', onePerRow: true },
    { id: 'rules', emoji: '', label: 'Правила', visible: true, order: 2, style: 'default', onePerRow: false },
    { id: 'help', emoji: '', label: 'Помощь', visible: true, order: 3, style: 'default', onePerRow: false },
  ],
  visual: {
    welcomeMessage: 'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Rezeis VPN.',
    welcomeMessageEn: null,
    botDescription: 'Быстрый и надёжный VPN',
    supportUsername: '',
    channelUsername: '',
    subscriptionInfoFormat: 'full',
    bannerUrl: null,
  },
  features: {
    referralsEnabled: true,
    promoCodesEnabled: true,
    trialEnabled: false,
    miniAppEnabled: true,
    activityFeedEnabled: true,
    partnersEnabled: false,
  },
  botEmojis: {},
  menuTextCustomEmojiIds: {},
};
