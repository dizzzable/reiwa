/**
 * RedisConfigPersistence
 * ──────────────────────
 * ioredis-backed `ConfigPersistencePort`. Stores the last-known-good
 * bot-config snapshot under a single key so the bot can seed its cache
 * from it on a cold restart instead of the hardcoded Reiwa default.
 *
 * Design notes:
 *   - `lazyConnect` + an `error` event handler mirror `SessionStore`, so a
 *     Redis outage degrades gracefully (warn-logged) rather than crashing
 *     the bot process.
 *   - Both methods are best-effort and never throw: `save` swallows write
 *     errors, `load` returns `null` on any miss / parse / shape failure.
 *   - A lightweight shape check guards against a corrupt or
 *     schema-drifted snapshot poisoning the bot on boot.
 */
import { Redis } from 'ioredis';

import type { ConfigPersistencePort } from '../../application/ports/config-persistence.port.js';
import type { LoggerPort } from '../../application/ports/logger.port.js';

import type { BotConfig } from './types.js';

const KEY = 'reiwa:botconfig:last-known-good';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface RedisConfigPersistenceOptions {
  readonly logger?: LoggerPort;
  /** Override the storage key (tests). */
  readonly key?: string;
  /** Override the TTL in seconds (tests). */
  readonly ttlSeconds?: number;
}

/** Minimal structural guard — enough to reject corrupt / drifted JSON. */
function isBotConfigShape(value: unknown): value is BotConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.buttons) &&
    typeof v.visual === 'object' &&
    v.visual !== null &&
    typeof v.features === 'object' &&
    v.features !== null
  );
}

export class RedisConfigPersistence implements ConfigPersistencePort {
  private readonly redis: Redis;
  private readonly key: string;
  private readonly ttlSeconds: number;
  private readonly logger: LoggerPort | undefined;

  constructor(redisUrl: string, options: RedisConfigPersistenceOptions = {}) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
    this.key = options.key ?? KEY;
    this.ttlSeconds = options.ttlSeconds ?? TTL_SECONDS;
    this.logger = options.logger;
    this.redis.on('error', (err: Error) => {
      if (this.logger) {
        this.logger.warn(
          { err, component: 'RedisConfigPersistence' },
          'Redis error',
        );
      } else {
        // eslint-disable-next-line no-console
        console.error('[RedisConfigPersistence] Redis error:', err.message);
      }
    });
  }

  async load(): Promise<BotConfig | null> {
    try {
      const raw = await this.redis.get(this.key);
      if (raw === null || raw.length === 0) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isBotConfigShape(parsed)) {
        this.logger?.warn(
          { component: 'RedisConfigPersistence' },
          'persisted snapshot failed shape check — ignoring',
        );
        return null;
      }
      return parsed;
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'RedisConfigPersistence: load failed');
      return null;
    }
  }

  async save(config: BotConfig): Promise<void> {
    try {
      await this.redis.set(
        this.key,
        JSON.stringify(config),
        'EX',
        this.ttlSeconds,
      );
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'RedisConfigPersistence: save failed');
    }
  }

  /** Close the underlying connection (graceful shutdown / tests). */
  disconnect(): void {
    this.redis.disconnect();
  }
}
