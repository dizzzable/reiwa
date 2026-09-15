/**
 * What the channel gate («Канал обязателен») keeps beyond one process.
 *
 * Two processes decide the gate: reiwa-bot for bot updates and reiwa-api for
 * the Mini App. They share one `.env` and one `REDIS_URL`, and they must share
 * two things through it:
 *
 *  - PASSES while «Перепроверять подписку» is OFF. The panel promises "checked
 *    only at the first entry", so a pass has to outlive a deploy, a restart and
 *    the process that recorded it — a user let in by the Mini App is let in by
 *    the bot too.
 *  - THE OPERATOR-ALERT THROTTLE. A misconfigured gate is one problem, and the
 *    operator should hear about it once an hour, not once an hour per process.
 *
 * Everything else the gate remembers (the one-minute passes of the strict mode,
 * the short "not subscribed" memo, back-offs) is per process on purpose: those
 * are read on every update, and a Redis round trip per button press is the
 * cost this split exists to avoid.
 *
 * ── CONTRACT ──────────────────────────────────────────────────────────────
 *
 * Every method is async and NEVER rejects. An implementation that cannot reach
 * its backing store answers from process memory instead and logs that it did
 * (throttled): a Redis outage must degrade the gate to single-process
 * behaviour, not break it.
 *
 * Passes are keyed by the RESOLVED chat id (`resolveChannelChatId`), with a
 * username lower-cased ({@link channelGateChatKey}), and the Telegram user id —
 * so pointing the gate at another channel re-checks everyone, and retyping
 * «Username канала» in another case does not.
 */
import { TtlMap } from './ttl-map.js';

export interface ChannelGateStore {
  /** Whether `userId` has a live pass for `chatId`. */
  hasPass(chatId: string, userId: number): Promise<boolean>;
  /** Records a pass for `ttlMs`, replacing any earlier one. */
  recordPass(chatId: string, userId: number, ttlMs: number): Promise<void>;
  /** Drops the pass, if any. */
  forgetPass(chatId: string, userId: number): Promise<void>;
  /**
   * `true` for the FIRST claim of `key` within `ttlMs`, across every process
   * sharing the store; `false` for every later one until it expires. The gate
   * alerts the operator only when this answers `true`.
   */
  claimAlert(key: string, ttlMs: number): Promise<boolean>;
}

/**
 * The spelling of a chat id every key uses. Telegram resolves a username
 * without regard to case, so `@Rezeis_News` and `@rezeis_news` are one channel
 * and must be one key; a numeric id is kept as is. A username and the numeric id
 * of the same channel stay two keys — nothing short of asking Telegram can tell
 * that they are one.
 */
export function channelGateChatKey(chatId: string): string {
  return chatId.startsWith('@') ? chatId.toLowerCase() : chatId;
}

/** Most passes one process keeps without a shared store; the oldest go first. */
const MEMORY_MAX_PASSES = 100_000;
/** Most alert claims one process keeps; there are a handful of causes. */
const MEMORY_MAX_ALERTS = 1_000;

/**
 * The store a process uses when no shared one is configured, and what the
 * Redis store answers from while Redis is unreachable. Scoped to one process
 * and lost on restart — which is exactly the difference `REDIS_URL` makes.
 */
export class MemoryChannelGateStore implements ChannelGateStore {
  private readonly passes = new TtlMap<string>({ maxEntries: MEMORY_MAX_PASSES });
  private readonly alerts = new TtlMap<string>({ maxEntries: MEMORY_MAX_ALERTS });

  public async hasPass(chatId: string, userId: number): Promise<boolean> {
    return this.passes.has(passId(chatId, userId));
  }

  public async recordPass(chatId: string, userId: number, ttlMs: number): Promise<void> {
    this.passes.set(passId(chatId, userId), true, ttlMs);
  }

  public async forgetPass(chatId: string, userId: number): Promise<void> {
    this.passes.delete(passId(chatId, userId));
  }

  public async claimAlert(key: string, ttlMs: number): Promise<boolean> {
    if (this.alerts.has(key)) return false;
    this.alerts.set(key, true, ttlMs);
    return true;
  }

  /** Forgets every pass and claim (tests; a process restart does the same). */
  public clear(): void {
    this.passes.clear();
    this.alerts.clear();
  }
}

function passId(chatId: string, userId: number): string {
  return `${channelGateChatKey(chatId)}:${userId}`;
}
