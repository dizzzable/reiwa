/**
 * The newest version of each panel settings group that anything in reiwa has
 * heard of, in one small Redis hash.
 *
 * Two processes hear from the panel: reiwa-api (the settings webhook, and its
 * version poll) and reiwa-bot (its version poll). The bot answers button
 * presses, and on every press it asks whether the copy it holds is behind what
 * reiwa already knows (`bot/middleware/config-freshness.ts`). Asking the PANEL
 * there would make every press as slow as the panel, and a hung panel would
 * hang the bot; this key is one Redis read, and a burst of presses shares it
 * (`memoiseLatest`).
 *
 * ── What it holds (`redis/keys.ts` `latestConfigVersionsKey`) ────────────────
 *
 *  - `poll:<group>` = `{ version, at }`: the panel's version of the group as the
 *    last poll to finish heard it, and when its answer came. Written by every
 *    `ConfigVersionPoller` after an answered poll — both processes, every group
 *    the panel versions.
 *  - `hint:<group>` = `at`: when the panel's settings webhook last said the
 *    group changed. Written by reiwa-api as a hint for a group the bot reads
 *    arrives, before it dials the bot. The webhook does not carry the new
 *    version, only that there is one.
 *
 * ── Why times, and not only versions ─────────────────────────────────────────
 *
 * A version says what the panel had, not when. A copy the bot began to read
 * AFTER a poll answered, or after a hint came, is at least as new as what the
 * key says — even when the two versions differ: the panel moved on again, or a
 * slower process wrote an older poll over a newer one (plain HSETs, no
 * compare-and-set: the last writer wins). So the bot counts a mark only when it
 * is newer than the start of the read its copy came from, and each mark gets
 * one read at most (`BotConfigCache.catchUp`): no mark makes the bot read the
 * panel twice, and a key that lags cannot make it read in a loop.
 *
 * reiwa-api and reiwa-bot run side by side on one host (`docker-compose.yml`),
 * so the times they write and compare are the host's one clock.
 *
 * Best-effort both ways: a Redis problem is never the reason a press waits or
 * fails. Writes swallow their errors with a log line; a read that fails, or
 * does not answer in time, is `null` — "nothing known", and the bot answers
 * from what it holds.
 */
import type { Redis } from 'ioredis';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import { latestConfigVersionsKey } from '../redis/keys.js';
import type { ConfigVersionKey } from './config-version.js';

/** What a poll heard the panel say about one group, and when. */
export interface PanelVersionSeen {
  readonly version: string;
  /** Epoch ms the poll's answer came. */
  readonly at: number;
}

/** Everything the key holds, per group. */
export interface LatestConfigVersions {
  /** The panel's version of each group, as the last poll to finish heard it. */
  readonly polled: Readonly<Record<string, PanelVersionSeen>>;
  /** When the panel's webhook last said each group changed, epoch ms. */
  readonly hinted: Readonly<Record<string, number>>;
}

/** What reiwa knows of one group: the input of `BotConfigCache.catchUp`. */
export interface KnownPanelChange {
  readonly polled?: PanelVersionSeen;
  readonly hintedAt?: number;
}

export interface LatestConfigVersionsPort {
  /** Record an answered poll: every version in it, heard at `at`. Never throws. */
  recordPoll(versions: Readonly<Record<string, string>>, at: number): Promise<void>;
  /** Record that the panel said `groups` changed, at `at`. Never throws. */
  recordHint(groups: readonly ConfigVersionKey[], at: number): Promise<void>;
  /** The key's content; `null` when it cannot be read. Never throws. */
  read(): Promise<LatestConfigVersions | null>;
}

/** For tests and Redis-free deployments: nothing is kept, nothing is known. */
export const NOOP_LATEST_CONFIG_VERSIONS: LatestConfigVersionsPort = {
  recordPoll: async () => undefined,
  recordHint: async () => undefined,
  read: async () => null,
};

const POLL_FIELD = 'poll:';
const HINT_FIELD = 'hint:';

/** A version the key accepts: what the poll accepts from the panel, bounded. */
function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The part of a group's key reiwa knows about: a poll's version and a hint's time. */
export function knownChangeOf(latest: LatestConfigVersions | null, group: ConfigVersionKey): KnownPanelChange {
  if (latest === null) return {};
  const polled = latest.polled[group];
  const hintedAt = latest.hinted[group];
  return {
    ...(polled !== undefined ? { polled } : {}),
    ...(hintedAt !== undefined ? { hintedAt } : {}),
  };
}

type LatestRedis = Pick<Redis, 'hset' | 'hgetall'>;

export class RedisLatestConfigVersions implements LatestConfigVersionsPort {
  private readonly redis: LatestRedis;
  private readonly logger: LoggerPort | undefined;

  public constructor(options: { readonly redis: LatestRedis; readonly logger?: LoggerPort }) {
    this.redis = options.redis;
    this.logger = options.logger;
  }

  public async recordPoll(versions: Readonly<Record<string, string>>, at: number): Promise<void> {
    const fields: Record<string, string> = {};
    for (const [group, version] of Object.entries(versions)) {
      if (isVersion(version)) fields[`${POLL_FIELD}${group}`] = JSON.stringify({ version, at });
    }
    await this.write(fields, 'poll');
  }

  public async recordHint(groups: readonly ConfigVersionKey[], at: number): Promise<void> {
    const fields: Record<string, string> = {};
    for (const group of groups) fields[`${HINT_FIELD}${group}`] = String(at);
    await this.write(fields, 'hint');
  }

  public async read(): Promise<LatestConfigVersions | null> {
    let raw: Record<string, string>;
    try {
      raw = await this.redis.hgetall(latestConfigVersionsKey());
    } catch (err: unknown) {
      this.logger?.debug({ err }, 'latest config versions: read failed; answering from what is held');
      return null;
    }
    const polled: Record<string, PanelVersionSeen> = {};
    const hinted: Record<string, number> = {};
    for (const [field, value] of Object.entries(raw ?? {})) {
      if (field.startsWith(POLL_FIELD)) {
        const seen = parsePolled(value);
        if (seen !== null) polled[field.slice(POLL_FIELD.length)] = seen;
      } else if (field.startsWith(HINT_FIELD)) {
        const at = Number(value);
        if (isTime(at)) hinted[field.slice(HINT_FIELD.length)] = at;
      }
    }
    return { polled, hinted };
  }

  private async write(fields: Record<string, string>, what: 'poll' | 'hint'): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    try {
      await this.redis.hset(latestConfigVersionsKey(), fields);
    } catch (err: unknown) {
      this.logger?.warn({ err, what }, 'latest config versions: write failed');
    }
  }
}

/** One `poll:` field, or `null` when it is not what this file writes. */
function parsePolled(value: string): PanelVersionSeen | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { version, at } = parsed as { version?: unknown; at?: unknown };
    return isVersion(version) && isTime(at) ? { version, at } : null;
  } catch {
    return null;
  }
}

/** How long one read of the key answers the presses after it. */
export const LATEST_READ_REUSE_MS = 1_500;

/**
 * How long a press waits for Redis to give the key before it answers from what
 * the bot holds. Redis is on the same host and answers in about a millisecond;
 * this is far above that and far below the 250 ms a toast may wait.
 */
export const LATEST_READ_TIMEOUT_MS = 100;

/**
 * One read of the key shared by the presses of a moment.
 *
 *  - A read in flight is joined.
 *  - What a read answered — `null` for a failure — answers every press for
 *    `reuseMs` after it came.
 *  - A read that has not answered within `timeoutMs` answers `null` to
 *    everybody waiting on it, and that `null` is reused like any answer: a Redis
 *    that hangs costs one short wait per `reuseMs`, not one per press. Updates
 *    are handled one at a time, so that wait would otherwise hold every update
 *    queued behind.
 */
export function memoiseLatest(
  read: () => Promise<LatestConfigVersions | null>,
  options: { readonly reuseMs?: number; readonly timeoutMs?: number } = {},
): () => Promise<LatestConfigVersions | null> {
  const reuseMs = options.reuseMs ?? LATEST_READ_REUSE_MS;
  const timeoutMs = options.timeoutMs ?? LATEST_READ_TIMEOUT_MS;
  let current: { readonly answer: Promise<LatestConfigVersions | null>; settledAt: number | null } | null = null;
  return () => {
    if (current !== null && (current.settledAt === null || Date.now() - current.settledAt < reuseMs)) {
      return current.answer;
    }
    let timer: NodeJS.Timeout | undefined;
    const slot: { answer: Promise<LatestConfigVersions | null>; settledAt: number | null } = {
      answer: Promise.resolve(null),
      settledAt: null,
    };
    slot.answer = Promise.race([
      Promise.resolve()
        .then(read)
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]).then((answer) => {
      if (timer !== undefined) clearTimeout(timer);
      slot.settledAt = Date.now();
      return answer;
    });
    current = slot;
    return slot.answer;
  };
}
