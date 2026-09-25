import { describe, expect, it, vi } from 'vitest';

import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import {
  LANDING_LKG,
  LAST_KNOWN_GOOD_RETRY_MS,
  LAST_KNOWN_GOOD_UNREADABLE,
  PLATFORM_POLICY_LKG,
  RedisLastKnownGoodStore,
  type LastKnownGoodGroup,
} from '../../../src/infrastructure/config-versions/last-known-good.js';
import { BOT_CONFIG_LKG } from '../../../src/infrastructure/bot-config/redis-config-persistence.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';

/**
 * The one store for every panel settings group's last good copy (W8 report
 * D11): one record shape, the shape number in the key, the old unversioned keys
 * read once and retired.
 */

/** A Redis double with the three commands the store sends, `SET … NX` included. */
function fakeRedis(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const redis = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...options: string[]) => {
      if (options.includes('NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
  return { data, redis };
}

const POLICY = { accessMode: 'INVITED', channelRequired: true, channelLink: 'https://t.me/x' };

function store(redis: ReturnType<typeof fakeRedis>['redis'], now = 1_700_000_000_000) {
  return new RedisLastKnownGoodStore({ redis: redis as never, now: () => now });
}

describe('the last-known-good record', () => {
  it('is written under reiwa:lkg:<group>:v<shape> as {shape, savedAt, hash, payload}, with no expiry', async () => {
    const { data, redis } = fakeRedis();
    await store(redis).save(PLATFORM_POLICY_LKG, POLICY);

    expect([...data.keys()]).toEqual(['reiwa:lkg:platform-policy:v1']);
    expect(JSON.parse(data.get('reiwa:lkg:platform-policy:v1') as string)).toEqual({
      shape: 1,
      savedAt: 1_700_000_000_000,
      hash: configVersionOf(POLICY),
      payload: POLICY,
    });
    // No `EX`: a copy that expires turns a long outage back into the defaults.
    expect(redis.set).toHaveBeenCalledWith('reiwa:lkg:platform-policy:v1', expect.any(String));
  });

  it('keeps the hash it is handed — a payload stamped after the panel answered keeps the answer’s version', async () => {
    const { data, redis } = fakeRedis();
    await store(redis).save(PLATFORM_POLICY_LKG, POLICY, 'a'.repeat(32));
    expect(JSON.parse(data.get('reiwa:lkg:platform-policy:v1') as string).hash).toBe('a'.repeat(32));
  });

  it('is read back whole', async () => {
    const { redis } = fakeRedis();
    const lkg = store(redis);
    await lkg.save(PLATFORM_POLICY_LKG, POLICY);
    expect(await lkg.load(PLATFORM_POLICY_LKG)).toEqual({
      shape: 1,
      savedAt: 1_700_000_000_000,
      hash: configVersionOf(POLICY),
      payload: POLICY,
    });
  });

  it('is not served when its payload fails the group’s check', async () => {
    const { redis } = fakeRedis({
      'reiwa:lkg:platform-policy:v1': JSON.stringify({ shape: 1, savedAt: 1, hash: 'x', payload: { mode: 'PUBLIC' } }),
    });
    expect(await store(redis).load(PLATFORM_POLICY_LKG)).toBeNull();
  });

  it('is never read by a group of another shape: a new shape reads only what it wrote', async () => {
    const { redis } = fakeRedis();
    const lkg = store(redis);
    await lkg.save(PLATFORM_POLICY_LKG, POLICY);
    const nextShape: LastKnownGoodGroup<Record<string, unknown>> = { ...PLATFORM_POLICY_LKG, shape: 2 };
    expect(await lkg.load(nextShape)).toBeNull();
    // Anchor: the shape-1 record is there, and still read by shape 1.
    expect(await lkg.load(PLATFORM_POLICY_LKG)).not.toBeNull();
  });

  it('does not write a payload too large to be a settings group', async () => {
    const { data, redis } = fakeRedis();
    await expect(
      store(redis).save({ ...LANDING_LKG, maxBytes: 64 }, { enabled: true, text: 'x'.repeat(100) }),
    ).resolves.toBe('too-large');
    expect(data.size).toBe(0);
  });

  it('answers what a save did: saved, or not saved when Redis refused it', async () => {
    const { redis } = fakeRedis();
    await expect(store(redis).save(PLATFORM_POLICY_LKG, POLICY)).resolves.toBe('saved');
    redis.set.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(store(redis).save(PLATFORM_POLICY_LKG, POLICY)).resolves.toBe('not-saved');
  });

  it('never throws: a Redis failure reads as "unreadable" — NOT as "no copy" — and a failed write as nothing done', async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      set: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      del: vi.fn(async () => 0),
    };
    const lkg = store(redis as never);
    await expect(lkg.load(PLATFORM_POLICY_LKG)).resolves.toBe(LAST_KNOWN_GOOD_UNREADABLE);
    await expect(lkg.save(PLATFORM_POLICY_LKG, POLICY)).resolves.toBe('not-saved');
  });

  it('a stored copy that is not JSON is "no copy" — Redis answered — not "unreadable"', async () => {
    const { redis } = fakeRedis({ 'reiwa:lkg:platform-policy:v1': '{not json' });
    await expect(store(redis).load(PLATFORM_POLICY_LKG)).resolves.toBeNull();
  });
});

describe('a Redis that could not be read (review R2a-01)', () => {
  /** A Redis that fails every GET until `open()`. */
  function closedRedis(initial: Record<string, string>) {
    const { data, redis } = fakeRedis(initial);
    let closed = true;
    const answer = redis.get.getMockImplementation() as (key: string) => Promise<string | null>;
    redis.get.mockImplementation(async (key: string) => {
      if (closed) throw new Error('Command timed out');
      return answer(key);
    });
    return { data, redis, open: () => (closed = false) };
  }

  it('is asked again after the pause, and not before: one GET per pause, however many reads', async () => {
    const saved = JSON.stringify({ shape: 1, savedAt: 1, hash: configVersionOf(POLICY), payload: POLICY });
    const { redis, open } = closedRedis({ 'reiwa:lkg:platform-policy:v1': saved });
    let now = 1_700_000_000_000;
    const lkg = new RedisLastKnownGoodStore({ redis: redis as never, now: () => now });

    expect(await lkg.load(PLATFORM_POLICY_LKG)).toBe(LAST_KNOWN_GOOD_UNREADABLE);
    open();
    // Within the pause: answered at once, Redis not asked.
    now += LAST_KNOWN_GOOD_RETRY_MS - 1;
    expect(await lkg.load(PLATFORM_POLICY_LKG)).toBe(LAST_KNOWN_GOOD_UNREADABLE);
    expect(await lkg.load(PLATFORM_POLICY_LKG)).toBe(LAST_KNOWN_GOOD_UNREADABLE);
    expect(redis.get).toHaveBeenCalledTimes(1);

    now += 1;
    expect((await lkg.load(PLATFORM_POLICY_LKG)) as unknown).toMatchObject({ payload: POLICY });
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  it('warns once per streak of failures, not once per read', async () => {
    const { redis, open } = closedRedis({});
    let now = 0;
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const lkg = new RedisLastKnownGoodStore({ redis: redis as never, logger: logger as never, now: () => now });
    for (let read = 0; read < 3; read += 1) {
      await lkg.load(PLATFORM_POLICY_LKG);
      now += LAST_KNOWN_GOOD_RETRY_MS;
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(2);
    open();
    expect(await lkg.load(PLATFORM_POLICY_LKG)).toBeNull();
  });

  it('a failed read of the key from before the record does not mark it as read: after the pause it is moved and served', async () => {
    const LEGACY = 'reiwa:botconfig:last-known-good';
    const { data, redis } = fakeRedis({ [LEGACY]: JSON.stringify(DEFAULT_BOT_CONFIG) });
    // The new key answers (empty); the old key's GET fails once.
    let legacyFailures = 1;
    const answer = redis.get.getMockImplementation() as (key: string) => Promise<string | null>;
    redis.get.mockImplementation(async (key: string) => {
      if (key === LEGACY && legacyFailures > 0) {
        legacyFailures -= 1;
        throw new Error('Command timed out');
      }
      return answer(key);
    });
    let now = 0;
    const lkg = new RedisLastKnownGoodStore({ redis: redis as never, now: () => now });

    expect(await lkg.load(BOT_CONFIG_LKG)).toBe(LAST_KNOWN_GOOD_UNREADABLE);
    now += LAST_KNOWN_GOOD_RETRY_MS;
    expect((await lkg.load(BOT_CONFIG_LKG)) as unknown).toMatchObject({ payload: DEFAULT_BOT_CONFIG });
    expect(data.has('reiwa:lkg:bot-config:v1')).toBe(true);
  });
});

describe('a copy over the cap (review R2a-07)', () => {
  const BIG = { enabled: true, text: 'x'.repeat(200) };
  const SMALL_CAP = { ...LANDING_LKG, maxBytes: 64 };

  it('is not written; warned and reported once per version with its size — not once per save', async () => {
    const { data, redis } = fakeRedis();
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const reported: unknown[] = [];
    const lkg = new RedisLastKnownGoodStore({
      redis: redis as never,
      logger: logger as never,
      onTooLarge: (skipped) => reported.push(skipped),
    });

    for (let save = 0; save < 3; save += 1) await expect(lkg.save(SMALL_CAP, BIG)).resolves.toBe('too-large');

    expect(data.size).toBe(0);
    expect(reported).toEqual([
      { group: 'landing', hash: configVersionOf(BIG), bytes: expect.any(Number), maxBytes: 64 },
    ]);
    expect((reported[0] as { bytes: number }).bytes).toBeGreaterThan(200);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[1])).toMatch(/NOT saved/);

    // Another version over the cap is reported again.
    await lkg.save(SMALL_CAP, { ...BIG, text: 'y'.repeat(200) });
    expect(reported).toHaveLength(2);
  });
});

describe('a copy kept under a key from before the record', () => {
  const LEGACY = 'reiwa:botconfig:last-known-good';
  const OLD_COPY = { ...DEFAULT_BOT_CONFIG, visual: { ...DEFAULT_BOT_CONFIG.visual, welcomeMessage: 'saved long ago' } };

  it('is served when the new key is missing, and moved under the new key', async () => {
    const { data, redis } = fakeRedis({ [LEGACY]: JSON.stringify(OLD_COPY) });

    const loaded = await store(redis).load(BOT_CONFIG_LKG);

    expect(loaded).toEqual({ shape: 1, savedAt: null, hash: configVersionOf(OLD_COPY), payload: OLD_COPY });
    expect(JSON.parse(data.get('reiwa:lkg:bot-config:v1') as string).payload).toEqual(OLD_COPY);
  });

  it('never overwrites a newer copy another process saved meanwhile (SET … NX)', async () => {
    const { data, redis } = fakeRedis({ [LEGACY]: JSON.stringify(OLD_COPY) });
    const fresh = { ...DEFAULT_BOT_CONFIG, visual: { ...DEFAULT_BOT_CONFIG.visual, welcomeMessage: 'fresh' } };
    // The other process's save lands between this one's two reads.
    redis.get.mockImplementationOnce(async () => null);
    redis.get.mockImplementationOnce(async (key: string) => {
      data.set('reiwa:lkg:bot-config:v1', JSON.stringify({ shape: 1, savedAt: 2, hash: 'h', payload: fresh }));
      return data.get(key) ?? null;
    });

    await store(redis).load(BOT_CONFIG_LKG);

    expect(JSON.parse(data.get('reiwa:lkg:bot-config:v1') as string).payload).toEqual(fresh);
  });

  it('is read once per process: a missing old key is not asked for again', async () => {
    const { redis } = fakeRedis();
    const lkg = store(redis);
    await lkg.load(BOT_CONFIG_LKG);
    await lkg.load(BOT_CONFIG_LKG);
    expect(redis.get.mock.calls.filter(([key]) => key === LEGACY)).toHaveLength(1);
  });

  it('is deleted by the first save under the new key', async () => {
    const { data, redis } = fakeRedis({ [LEGACY]: JSON.stringify(OLD_COPY) });
    await store(redis).save(BOT_CONFIG_LKG, DEFAULT_BOT_CONFIG);
    expect(data.has(LEGACY)).toBe(false);
    expect(data.has('reiwa:lkg:bot-config:v1')).toBe(true);
  });

  it('is ignored when it fails the group’s check', async () => {
    const { data, redis } = fakeRedis({ [LEGACY]: JSON.stringify({ buttons: 'not a list' }) });
    expect(await store(redis).load(BOT_CONFIG_LKG)).toBeNull();
    expect(data.has('reiwa:lkg:bot-config:v1')).toBe(false);
  });
});
