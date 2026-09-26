import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NOOP_LATEST_CONFIG_VERSIONS,
  RedisLatestConfigVersions,
  knownChangeOf,
  memoiseLatest,
  type LatestConfigVersions,
} from '../../../src/infrastructure/config-versions/latest.js';
import { latestConfigVersionsKey } from '../../../src/infrastructure/redis/keys.js';

/**
 * The key of latest versions: what both processes' polls heard the panel say,
 * and when the panel's webhook said a group changed — the thing the bot
 * compares its copy with on every press.
 *
 * Pinned here: what is written where, that what does not parse is not known,
 * that Redis trouble is "nothing known" and never a throw, and that a burst of
 * presses costs one Redis read — including a Redis that hangs.
 */

const V1 = '1'.repeat(32);
const V2 = '2'.repeat(32);

/** A Redis hash in memory: HSET merges, HGETALL answers what is there. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const redis = {
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      const hash = hashes.get(key) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(fields)) hash.set(field, value);
      hashes.set(key, hash);
      return Object.keys(fields).length;
    }),
    hgetall: vi.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map<string, string>())),
  };
  return { redis, hashes };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RedisLatestConfigVersions', () => {
  it('keeps what a poll heard per group, and a hint’s time per group, in one hash', async () => {
    const { redis, hashes } = fakeRedis();
    const store = new RedisLatestConfigVersions({ redis: redis as never });

    await store.recordPoll({ botConfig: V1, 'legalDocuments.ru': V2 }, 1_000);
    await store.recordHint(['botConfig', 'legalDocuments.en'], 2_000);

    expect([...hashes.keys()]).toEqual([latestConfigVersionsKey()]);
    expect(latestConfigVersionsKey()).toBe('reiwa:config-versions:latest:v1');
    expect(await store.read()).toEqual({
      polled: {
        botConfig: { version: V1, at: 1_000 },
        'legalDocuments.ru': { version: V2, at: 1_000 },
      },
      hinted: { botConfig: 2_000, 'legalDocuments.en': 2_000 },
    });
  });

  it('a later poll replaces a group’s version and time, and leaves the other groups and the hints alone', async () => {
    const { redis } = fakeRedis();
    const store = new RedisLatestConfigVersions({ redis: redis as never });
    await store.recordPoll({ botConfig: V1, connectPage: V1 }, 1_000);
    await store.recordHint(['botConfig'], 1_500);

    await store.recordPoll({ botConfig: V2 }, 3_000);

    expect(await store.read()).toEqual({
      polled: { botConfig: { version: V2, at: 3_000 }, connectPage: { version: V1, at: 1_000 } },
      hinted: { botConfig: 1_500 },
    });
  });

  it('keeps a group this cabinet no longer has, as a panel still names it — nothing reads it back', async () => {
    // The panel still versions `landing` (live up to 0.9.7.70, as the retired
    // shim's constant from 0.9.7.71); the cabinet serves no landing since
    // 0.9.7.54. The poll hands the whole answer over, and the key is stored
    // like any other: harmless, since only the cabinet's own groups are ever
    // looked up in it (`knownChangeOf`).
    const { redis } = fakeRedis();
    const store = new RedisLatestConfigVersions({ redis: redis as never });
    await expect(store.recordPoll({ botConfig: V1, landing: V2 }, 1_000)).resolves.toBeUndefined();
    const latest = await store.read();
    expect(latest?.polled['landing']).toEqual({ version: V2, at: 1_000 });
    expect(knownChangeOf(latest, 'botConfig')).toEqual({ polled: { version: V1, at: 1_000 } });
  });

  it('knows nothing of a field it did not write: another writer’s, a broken one', async () => {
    const { redis, hashes } = fakeRedis();
    hashes.set(
      latestConfigVersionsKey(),
      new Map([
        ['poll:botConfig', '{"version":"","at":5}'],
        ['poll:guestSupport', 'not json'],
        ['poll:publicConfig', '{"version":"abc","at":"yesterday"}'],
        ['hint:botConfig', 'soon'],
        ['hint:guestSupport', '-3'],
        ['something:else', '1'],
        ['poll:connectPage', `{"version":"${V1}","at":7}`],
      ]),
    );
    const store = new RedisLatestConfigVersions({ redis: redis as never });

    expect(await store.read()).toEqual({ polled: { connectPage: { version: V1, at: 7 } }, hinted: {} });
  });

  it('a poll with no version worth keeping writes nothing', async () => {
    const { redis } = fakeRedis();
    const store = new RedisLatestConfigVersions({ redis: redis as never });
    await store.recordPoll({ botConfig: '' }, 1_000);
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('Redis failing is "nothing known" on a read and a log line on a write — never a throw', async () => {
    const log = logger();
    const broken = {
      hset: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      hgetall: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    };
    const store = new RedisLatestConfigVersions({ redis: broken as never, logger: log as never });

    await expect(store.recordPoll({ botConfig: V1 }, 1)).resolves.toBeUndefined();
    await expect(store.recordHint(['botConfig'], 1)).resolves.toBeUndefined();
    await expect(store.read()).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('the no-Redis store knows nothing and keeps nothing', async () => {
    await NOOP_LATEST_CONFIG_VERSIONS.recordPoll({ botConfig: V1 }, 1);
    await NOOP_LATEST_CONFIG_VERSIONS.recordHint(['botConfig'], 1);
    expect(await NOOP_LATEST_CONFIG_VERSIONS.read()).toBeNull();
  });
});

describe('knownChangeOf', () => {
  const latest: LatestConfigVersions = {
    polled: { botConfig: { version: V1, at: 10 } },
    hinted: { botConfig: 20, 'legalDocuments.ru': 30 },
  };

  it('is one group’s poll and hint', () => {
    expect(knownChangeOf(latest, 'botConfig')).toEqual({ polled: { version: V1, at: 10 }, hintedAt: 20 });
    expect(knownChangeOf(latest, 'legalDocuments.ru')).toEqual({ hintedAt: 30 });
    expect(knownChangeOf(latest, 'connectPage')).toEqual({});
  });

  it('is nothing when nothing could be read', () => {
    expect(knownChangeOf(null, 'botConfig')).toEqual({});
  });
});

describe('memoiseLatest — one Redis read for a burst of presses', () => {
  const ANSWER: LatestConfigVersions = { polled: {}, hinted: { botConfig: 1 } };

  it('joins a read in flight, and answers from it for the reuse window after it came', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ANSWER);
    const latest = memoiseLatest(read, { reuseMs: 1_500, timeoutMs: 100 });

    const burst = await Promise.all([latest(), latest(), latest()]);
    expect(burst).toEqual([ANSWER, ANSWER, ANSWER]);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(await latest()).toBe(ANSWER);
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await latest();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a read that fails is "nothing known", reused like any answer', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (): Promise<LatestConfigVersions | null> => {
      throw new Error('boom');
    });
    const latest = memoiseLatest(read, { reuseMs: 1_500, timeoutMs: 100 });

    expect(await latest()).toBeNull();
    expect(await latest()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a Redis that hangs costs the first press the timeout, and the presses after it nothing', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<LatestConfigVersions | null>(() => undefined));
    const latest = memoiseLatest(read, { reuseMs: 1_500, timeoutMs: 100 });

    let first: LatestConfigVersions | null | 'pending' = 'pending';
    void latest().then((answer) => {
      first = answer;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(first).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toBeNull();

    // Answered at once — no timer needs to run.
    let second: LatestConfigVersions | null | 'pending' = 'pending';
    void latest().then((answer) => {
      second = answer;
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(second).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('waits the default timeout, a tenth of a second, and reuses for a second and a half', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<LatestConfigVersions | null>(() => undefined));
    const latest = memoiseLatest(read);
    let answered = false;
    void latest().then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBe(true);
    await vi.advanceTimersByTimeAsync(1_499);
    void latest();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    void latest();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
