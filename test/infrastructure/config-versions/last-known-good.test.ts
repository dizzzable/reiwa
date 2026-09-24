import { describe, expect, it, vi } from 'vitest';

import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import {
  LANDING_LKG,
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
    await store(redis).save({ ...LANDING_LKG, maxBytes: 64 }, { enabled: true, text: 'x'.repeat(100) });
    expect(data.size).toBe(0);
  });

  it('never throws: a Redis failure reads as "no copy" and a failed write as nothing done', async () => {
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
    await expect(lkg.load(PLATFORM_POLICY_LKG)).resolves.toBeNull();
    await expect(lkg.save(PLATFORM_POLICY_LKG, POLICY)).resolves.toBeUndefined();
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
