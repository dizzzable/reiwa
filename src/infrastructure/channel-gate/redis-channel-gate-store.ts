/**
 * Redis-backed {@link ChannelGateStore}: the pass memory and the operator-alert
 * throttle that reiwa-bot and reiwa-api share through one `REDIS_URL`.
 *
 * Keys (versioned, so a later change of shape can move to `v2` instead of
 * reading an old value as a new one; a username is lower-cased):
 *
 *   reiwa:channel-gate:v1:pass:<chatId>:<userId>    SET … PX <ttl>
 *   reiwa:channel-gate:v1:alert:<sha256 of cause>   SET … PX <ttl> NX
 *
 * The alert key is a digest because a cause names a chat and quotes Telegram's
 * refusal, and neither belongs in a key an operator reads in `redis-cli`.
 *
 * ── THE CLIENT IS NOT OURS ────────────────────────────────────────────────
 *
 * The composition root hands the client in and owns it: the bot builds one for
 * the gate, the API passes the session store's shared client. So this store
 * never adds an `error` listener — every `createApp` would add another, and a
 * session-store outage would be logged as a channel-gate failure. What it logs
 * comes from its own failed commands, at most once per
 * {@link STORE_WARN_INTERVAL_MS} per operation.
 *
 * ── A REDIS THAT IS NOT THERE MUST COST NOTHING ───────────────────────────
 *
 * The bot decides one update at a time. Every client in this app has a 2 s
 * command timeout and an offline queue, so while Redis is down or restarting a
 * `hasPass` waited two seconds and a `recordPass` two more — per decision — and
 * a Stars `pre_checkout_query` (ten seconds to answer) queued behind a few of
 * them missed its window. The store therefore answers from process memory,
 * WITHOUT SENDING A COMMAND:
 *  - while the client is not `ready` (a lazy client that was never asked is
 *    told to connect, and answered from memory meanwhile);
 *  - for {@link STORE_BREAKER_OPEN_MS} after a command failed.
 *
 * ── RECONCILING AN OUTAGE ─────────────────────────────────────────────────
 *
 *  - A pass recorded to memory while Redis could not take it still counts after
 *    Redis is back: `hasPass` is memory OR Redis.
 *  - A pass that could not be deleted leaves a tombstone for
 *    {@link STORE_TOMBSTONE_MS}, so the pass still sitting in Redis cannot let
 *    the user straight back in from this process. A later `recordPass` lifts it.
 */
import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import { MemoryChannelGateStore, channelGateChatKey, type ChannelGateStore } from './channel-gate-store.js';
import { TtlMap } from './ttl-map.js';

export const CHANNEL_GATE_KEY_PREFIX = 'reiwa:channel-gate:v1:';

/** How often one failing operation is logged. */
export const STORE_WARN_INTERVAL_MS = 10 * 60 * 1000;
/** How long no command is sent after one failed. */
export const STORE_BREAKER_OPEN_MS = 10 * 1000;
/** How long a pass that could not be deleted from Redis is treated as deleted by this process. */
export const STORE_TOMBSTONE_MS = 10 * 60 * 1000;

export function channelGatePassKey(chatId: string, userId: number): string {
  return `${CHANNEL_GATE_KEY_PREFIX}pass:${channelGateChatKey(chatId)}:${userId}`;
}

export function channelGateAlertKey(cause: string): string {
  return `${CHANNEL_GATE_KEY_PREFIX}alert:${createHash('sha256').update(cause).digest('hex')}`;
}

/** What this store reads and issues — what a test double has to provide. */
export type ChannelGateRedis = Pick<Redis, 'exists' | 'set' | 'del' | 'status'> & Partial<Pick<Redis, 'connect'>>;

export interface RedisChannelGateStoreOptions {
  readonly redis: ChannelGateRedis;
  readonly logger?: LoggerPort;
}

export class RedisChannelGateStore implements ChannelGateStore {
  private readonly redis: ChannelGateRedis;
  private readonly logger: LoggerPort | undefined;
  /** What every command that is not sent, or failed, is answered from. */
  private readonly memory = new MemoryChannelGateStore();
  private readonly tombstones = new TtlMap<string>({ maxEntries: 100_000 });
  private readonly warnedAt = new TtlMap<string>({ maxEntries: 100 });
  /** No command is sent before this. */
  private openUntil = 0;

  public constructor(options: RedisChannelGateStoreOptions) {
    this.redis = options.redis;
    this.logger = options.logger;
  }

  public async hasPass(chatId: string, userId: number): Promise<boolean> {
    const key = channelGatePassKey(chatId, userId);
    if (this.tombstones.has(key)) return false;
    if (await this.memory.hasPass(chatId, userId)) return true;
    if (!this.canSend()) return false;
    try {
      return (await this.redis.exists(key)) === 1;
    } catch (err: unknown) {
      this.failed('hasPass', err);
      return false;
    }
  }

  public async recordPass(chatId: string, userId: number, ttlMs: number): Promise<void> {
    const key = channelGatePassKey(chatId, userId);
    this.tombstones.delete(key);
    if (this.canSend()) {
      try {
        await this.redis.set(key, '1', 'PX', ttlMs);
        return;
      } catch (err: unknown) {
        this.failed('recordPass', err);
      }
    }
    await this.memory.recordPass(chatId, userId, ttlMs);
  }

  public async forgetPass(chatId: string, userId: number): Promise<void> {
    const key = channelGatePassKey(chatId, userId);
    await this.memory.forgetPass(chatId, userId);
    if (this.canSend()) {
      try {
        await this.redis.del(key);
        this.tombstones.delete(key);
        return;
      } catch (err: unknown) {
        this.failed('forgetPass', err);
      }
    }
    this.tombstones.set(key, true, STORE_TOMBSTONE_MS);
  }

  public async claimAlert(key: string, ttlMs: number): Promise<boolean> {
    if (this.canSend()) {
      try {
        return (await this.redis.set(channelGateAlertKey(key), '1', 'PX', ttlMs, 'NX')) === 'OK';
      } catch (err: unknown) {
        this.failed('claimAlert', err);
      }
    }
    return this.memory.claimAlert(key, ttlMs);
  }

  /** Whether a command may be sent now. Never sends one itself. */
  private canSend(): boolean {
    if (Date.now() < this.openUntil) return false;
    const status = this.redis.status;
    if (status === 'ready') return true;
    if (status === 'wait') {
      // A lazy client that nobody has asked yet: ask it to connect, answer from memory meanwhile.
      void this.redis.connect?.().catch(() => undefined);
    }
    this.warn(`status:${status}`, { status }, `Channel gate: Redis is ${status}; answering from this process's memory`);
    return false;
  }

  private failed(operation: string, err: unknown): void {
    this.openUntil = Date.now() + STORE_BREAKER_OPEN_MS;
    this.warn(
      operation,
      { err, operation },
      `Channel gate: Redis failed on ${operation}; answering from this process's memory for ${STORE_BREAKER_OPEN_MS / 1000} s`,
    );
  }

  private warn(key: string, context: object, message: string): void {
    if (this.warnedAt.has(key)) return;
    this.warnedAt.set(key, true, STORE_WARN_INTERVAL_MS);
    this.logger?.warn(context, message);
  }
}
