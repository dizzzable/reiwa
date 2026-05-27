/**
 * RedisUserLocaleCache specs.
 *
 * Uses an in-memory fake of the narrow `ioredis` surface the cache
 * touches (`get`, `set` with EX flag, `exists`). Keeps the test
 * hermetic — no docker-compose, no real Redis.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { RedisUserLocaleCache } from '../../../src/infrastructure/i18n/locale-detector/redis-user-locale-cache.js';

interface FakeRedis {
  store: Map<string, string>;
  ttls: Map<string, number>;
  failOn: Set<'get' | 'set' | 'exists'>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'>;
  exists(key: string): Promise<number>;
}

function buildFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const failOn = new Set<'get' | 'set' | 'exists'>();
  return {
    store,
    ttls,
    failOn,
    async get(key: string) {
      if (failOn.has('get')) throw new Error('boom: get');
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key: string, value: string, mode?: string, ttl?: number) {
      if (failOn.has('set')) throw new Error('boom: set');
      store.set(key, value);
      if (mode === 'EX' && typeof ttl === 'number') ttls.set(key, ttl);
      return 'OK';
    },
    async exists(key: string) {
      if (failOn.has('exists')) throw new Error('boom: exists');
      return store.has(key) ? 1 : 0;
    },
  };
}

describe('RedisUserLocaleCache', () => {
  let fake: FakeRedis;
  let cache: RedisUserLocaleCache;

  beforeEach(() => {
    fake = buildFakeRedis();
    // The class only touches get/set/exists so casting through `unknown`
    // is enough — full Redis surface is not required for the contract.
    cache = new RedisUserLocaleCache({ redis: fake as unknown as never });
  });

  it('returns the RU default for unknown user ids', async () => {
    expect(await cache.get(123)).toBe('ru');
    expect(await cache.has(123)).toBe(false);
  });

  it('persists locale writes under the reiwa:user-locale: prefix', async () => {
    await cache.set(42, 'en');
    expect(fake.store.get('reiwa:user-locale:42')).toBe('en');
    expect(await cache.get(42)).toBe('en');
    expect(await cache.has(42)).toBe(true);
  });

  it('writes a TTL of 90 days by default', async () => {
    await cache.set(7, 'en');
    expect(fake.ttls.get('reiwa:user-locale:7')).toBe(90 * 24 * 60 * 60);
  });

  it('honours the configurable ttlSeconds option', async () => {
    const c = new RedisUserLocaleCache({
      redis: fake as unknown as never,
      ttlSeconds: 3600,
    });
    await c.set(11, 'ru');
    expect(fake.ttls.get('reiwa:user-locale:11')).toBe(3600);
  });

  it('lowercases the supplied locale before storing', async () => {
    await cache.set(8, 'EN');
    expect(fake.store.get('reiwa:user-locale:8')).toBe('en');
  });

  it('coerces unsupported locales to the RU default before storing', async () => {
    await cache.set(9, 'fr');
    expect(fake.store.get('reiwa:user-locale:9')).toBe('ru');
  });

  it('coerces stale unsupported values out of Redis on read', async () => {
    fake.store.set('reiwa:user-locale:55', 'fr');
    expect(await cache.get(55)).toBe('ru');
  });

  // ── Failure modes (degraded operation) ────────────────────────────────────
  it('returns the RU default and swallows the error when get fails', async () => {
    fake.failOn.add('get');
    expect(await cache.get(1)).toBe('ru');
  });

  it('treats has() as false when exists fails', async () => {
    fake.failOn.add('exists');
    expect(await cache.has(1)).toBe(false);
  });

  it('swallows write failures so a Redis outage does not poison the turn', async () => {
    fake.failOn.add('set');
    await expect(cache.set(1, 'en')).resolves.toBeUndefined();
    expect(fake.store.has('reiwa:user-locale:1')).toBe(false);
  });
});
