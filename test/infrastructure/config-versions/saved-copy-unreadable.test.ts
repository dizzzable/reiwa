import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuestSupportConfigCache } from '../../../src/infrastructure/admin-client/guest-support-config-cache.js';
import type { GuestRuntimeConfig } from '../../../src/infrastructure/admin-client/namespaces/support.js';
import type { LegalDocument } from '../../../src/infrastructure/admin-client/namespaces/legal-documents.js';
import { LegalDocumentsCache } from '../../../src/infrastructure/admin-client/legal-documents-cache.js';
import { PolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import { RedisConfigPersistence } from '../../../src/infrastructure/bot-config/redis-config-persistence.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import {
  GUEST_SUPPORT_LKG,
  LAST_KNOWN_GOOD_RETRY_MS,
  PLATFORM_POLICY_LKG,
  RedisLastKnownGoodStore,
  legalDocumentsLastKnownGood,
} from '../../../src/infrastructure/config-versions/last-known-good.js';
import { BOT_CONFIG_LKG } from '../../../src/infrastructure/bot-config/redis-config-persistence.js';

/**
 * A restart that meets Redis a moment too early — not ready yet after a host
 * reboot, a command timeout — while the panel is down (review R2a-01).
 *
 * The store used to answer that read `null`, the same as "no copy", and every
 * cache below read its copy once and remembered the answer: the process served
 * the defaults — the access rules open to everybody, the stock buttons, «Правила»
 * on the legacy link, the guest chat without its captcha — for the whole outage,
 * with the operator's copy sitting in Redis a second later. The owner's rule:
 * PUBLIC (and every other default) only when no copy ever existed.
 *
 * Each case: the REAL store over a Redis whose first read fails and which
 * answers after that; the panel refuses throughout. The first read cannot know
 * the copy and serves the default; the read after the store's pause must serve
 * the copy.
 */

/** A Redis holding `initial` whose first `failures` GETs fail the way ioredis does. */
function flakyRedis(initial: Record<string, string>, failures = 1) {
  const data = new Map<string, string>(Object.entries(initial));
  let failuresLeft = failures;
  const redis = {
    get: vi.fn(async (key: string) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('Command timed out');
      }
      return data.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
  return { data, redis };
}

/** What a previous process left in Redis for `group`. */
async function savedBefore<T>(group: Parameters<RedisLastKnownGoodStore['save']>[0], payload: T): Promise<Record<string, string>> {
  const data = new Map<string, string>();
  const writer = new RedisLastKnownGoodStore({
    redis: {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      },
      del: async () => 0,
    } as never,
  });
  await writer.save(group as never, payload as never);
  return Object.fromEntries(data);
}

const panelDown = async (): Promise<never> => {
  throw new Error('connect ECONNREFUSED');
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a saved copy Redis could not be read for is asked for again, not taken for "none"', () => {
  it('PolicyCache: the operator’s INVITED policy after the pause — not the PUBLIC stand-in for the outage', async () => {
    const INVITED = {
      accessMode: 'INVITED',
      rulesRequired: false,
      rulesLink: null,
      channelRequired: true,
      channelLink: 'https://t.me/operator_news',
      defaultCurrency: 'RUB',
    };
    const { redis } = flakyRedis(await savedBefore(PLATFORM_POLICY_LKG, INVITED));
    const cache = new PolicyCache(panelDown, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });

    // Nothing can be known yet: the stand-in, as before.
    expect((await cache.get())._isFallback).toBe(true);

    vi.advanceTimersByTime(LAST_KNOWN_GOOD_RETRY_MS);
    const policy = await cache.get();
    expect(policy).toEqual(INVITED);
    expect(policy._isFallback).toBeUndefined();
    // Held from here on: no more Redis reads.
    const reads = redis.get.mock.calls.length;
    expect(await cache.get()).toEqual(INVITED);
    expect(redis.get.mock.calls.length).toBe(reads);
  });

  it('PolicyCache: Redis says "no copy" — the stand-in keeps its half-minute window (only a real "none" opens it)', async () => {
    const { redis } = flakyRedis({}, 0);
    const fetch = vi.fn(panelDown);
    const cache = new PolicyCache(fetch, { lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }) });
    expect((await cache.get())._isFallback).toBe(true);
    expect((await cache.get())._isFallback).toBe(true);
    const asked = fetch.mock.calls.length;
    vi.advanceTimersByTime(LAST_KNOWN_GOOD_RETRY_MS);
    expect((await cache.get())._isFallback).toBe(true);
    // Two failures in a row with a definite "none": the window holds the panel off.
    expect(fetch.mock.calls.length).toBe(asked);
  });

  it('BotConfigCache: the operator’s buttons after the pause — not the stock ones for the outage', async () => {
    const operatorConfig: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      buttons: [{ id: 'shop', emoji: '', label: 'Operator button', visible: true, order: 0, style: 'primary', onePerRow: true }],
    };
    const { redis } = flakyRedis(await savedBefore(BOT_CONFIG_LKG, operatorConfig));
    const cache = new BotConfigCache({
      fetcher: panelDown,
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
      persistence: new RedisConfigPersistence(new RedisLastKnownGoodStore({ redis: redis as never })),
      firstLoadBudgetMs: 50,
    });

    expect(await cache.get()).toBe(DEFAULT_BOT_CONFIG);

    // Still inside the failed fetch's ten-second hold-off: the panel is not
    // asked again, but the copy is.
    vi.advanceTimersByTime(LAST_KNOWN_GOOD_RETRY_MS);
    expect((await cache.get()).buttons.map((button) => button.label)).toEqual(['Operator button']);
    expect(cache.peek()?.buttons[0]?.label).toBe('Operator button');
  });

  it('LegalDocumentsCache: «Правила» gets the documents saved before the restart after the pause — not the legacy link', async () => {
    const OFFER: LegalDocument = { key: 'OFFER', title: 'Оферта', body: 'Текст' } as LegalDocument;
    const group = legalDocumentsLastKnownGood('ru');
    const { redis } = flakyRedis(await savedBefore(group, [OFFER]));
    const cache = new LegalDocumentsCache(panelDown, 60_000, 50, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });

    expect(await cache.get('ru')).toEqual([]);

    vi.advanceTimersByTime(LAST_KNOWN_GOOD_RETRY_MS);
    expect(await cache.get('ru')).toEqual([OFFER]);
  });

  it('GuestSupportConfigCache: the captcha is back after the pause — not dropped for a TTL, and not for the outage', async () => {
    const WITH_CAPTCHA: GuestRuntimeConfig = {
      enabled: true,
      turnstileSiteKey: '0x4AAAAAAAsite',
      turnstileSecret: '0x4AAAAAAAsecret',
    };
    const { redis } = flakyRedis(await savedBefore(GUEST_SUPPORT_LKG, WITH_CAPTCHA));
    const cache = new GuestSupportConfigCache(panelDown, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
      ttlMs: 30_000,
    });

    expect(await cache.get()).toBeNull();

    vi.advanceTimersByTime(LAST_KNOWN_GOOD_RETRY_MS);
    expect(await cache.get()).toEqual(WITH_CAPTCHA);
  });

  it('LegalDocumentsCache: a save Redis refused is written again with the next answer — not remembered as stored', async () => {
    const OFFER: LegalDocument = { key: 'OFFER', title: 'Оферта', body: 'Текст' } as LegalDocument;
    const { data, redis } = flakyRedis({}, 0);
    redis.set.mockImplementationOnce(async () => {
      throw new Error('Command timed out');
    });
    const cache = new LegalDocumentsCache(async () => [OFFER], 0, 50, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });
    const key = 'reiwa:lkg:legal-documents.ru:v1';

    await cache.get('ru');
    await vi.waitFor(() => expect(redis.set).toHaveBeenCalledTimes(1));
    expect(data.has(key)).toBe(false);

    // The same documents again (a TTL of 0: every tap reads).
    await cache.get('ru');
    await vi.waitFor(() => expect(data.has(key)).toBe(true));
    const writes = redis.set.mock.calls.length;
    // Stored now: the same version is not written a third time.
    await cache.get('ru');
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.set.mock.calls.length).toBe(writes);
  });
});
