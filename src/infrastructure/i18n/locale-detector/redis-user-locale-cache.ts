/**
 * Redis-backed `UserLocaleCachePort` implementation.
 *
 * Stores per-user locale choices behind a `reiwa:user-locale:<id>`
 * key with a long TTL (90 days). The bot writes here when the user
 * hits `/lang`; auto-detect middleware reads here on every update to
 * decide whether to honour Telegram's `language_code` (if `has` is
 * false) or stick with the persisted choice.
 *
 * Connection model: a single `ioredis` client passed in by the
 * composition root — the cache does not own the lifecycle. This keeps
 * graceful shutdown a single-line concern in `api/main.ts` and
 * `bot/main.ts`.
 *
 * Failure mode: any Redis read error returns the RU default (the bot
 * keeps working in degraded mode); writes are best-effort and swallow
 * errors so a Redis outage doesn't poison the user-facing turn.
 * Operators see the failure on the EventReporter channel via the
 * shared error log.
 */
import type { Redis } from 'ioredis';

import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../../core/enums/locale.enum.js';
import type { UserLocaleCachePort } from '../../../application/ports/user-locale-cache.port.js';
import type { LoggerPort } from '../../../application/ports/logger.port.js';

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const KEY_PREFIX = 'reiwa:user-locale:';

export interface RedisUserLocaleCacheOptions {
  readonly redis: Redis;
  readonly ttlSeconds?: number;
  readonly logger?: LoggerPort;
}

export class RedisUserLocaleCache implements UserLocaleCachePort {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly logger: LoggerPort | undefined;

  constructor(options: RedisUserLocaleCacheOptions) {
    this.redis = options.redis;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.logger = options.logger;
  }

  async get(userId: number): Promise<SupportedLocale> {
    try {
      const raw = await this.redis.get(this.key(userId));
      if (raw && isSupportedLocale(raw)) return raw;
      return DEFAULT_LOCALE;
    } catch (err: unknown) {
      this.logger?.warn({ err, userId }, 'RedisUserLocaleCache.get failed');
      return DEFAULT_LOCALE;
    }
  }

  async set(userId: number, lang: string | SupportedLocale): Promise<void> {
    const lower = typeof lang === 'string' ? lang.toLowerCase() : lang;
    const value: SupportedLocale = isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
    try {
      await this.redis.set(this.key(userId), value, 'EX', this.ttlSeconds);
    } catch (err: unknown) {
      this.logger?.warn({ err, userId, lang }, 'RedisUserLocaleCache.set failed');
    }
  }

  async has(userId: number): Promise<boolean> {
    try {
      const exists = await this.redis.exists(this.key(userId));
      return exists === 1;
    } catch (err: unknown) {
      this.logger?.warn({ err, userId }, 'RedisUserLocaleCache.has failed');
      return false;
    }
  }

  private key(userId: number): string {
    return `${KEY_PREFIX}${userId}`;
  }
}
