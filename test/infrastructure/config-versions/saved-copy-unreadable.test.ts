import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuestSupportConfigCache } from '../../../src/infrastructure/admin-client/guest-support-config-cache.js';
import type { GuestRuntimeConfig } from '../../../src/infrastructure/admin-client/namespaces/support.js';
import type { LegalDocument } from '../../../src/infrastructure/admin-client/namespaces/legal-documents.js';
import type { PlatformPolicyShape } from '../../../src/infrastructure/admin-client/namespaces/system.js';
import {
  LEGAL_DOCUMENTS_WAIT_BUDGET_MS,
  LegalDocumentsCache,
} from '../../../src/infrastructure/admin-client/legal-documents-cache.js';
import { POLICY_WAIT_BUDGET_MS, PolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG, FIRST_LOAD_BUDGET_MS } from '../../../src/infrastructure/bot-config/cache.js';
import { RedisConfigPersistence } from '../../../src/infrastructure/bot-config/redis-config-persistence.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import {
  GUEST_SUPPORT_LKG,
  LAST_KNOWN_GOOD_NONE_RECHECK_MS,
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

/**
 * The same restart with a panel that HANGS (review R3b-02). A VPS that is down
 * drops packets, so a read of the panel waits out the transport's ten seconds
 * instead of failing at once, and the copy used to be asked for again only when
 * that read failed. Once the first cold read had waited its budget, the reads
 * after it answered the defaults without asking Redis: for ten seconds the
 * channel gate was open, `/start` skipped REG_BLOCKED, RESTRICTED and INVITED,
 * the bot showed the stock buttons and «Правила» the legacy link — with Redis
 * back after two.
 *
 * The first read cannot know the copy and serves the default once its budget
 * is out, as before. Within the store's pause the reads answer at once and
 * Redis is not asked. The first read after the pause serves the copy at once,
 * the panel read still out, and the panel's answer replaces the copy when it
 * comes. Never a long wait: a read of Redis that hangs as well holds a read the
 * budget at most, and one read per read of Redis.
 */
describe('…and the panel hangs: the copy right after the store’s pause, not when the panel read gives up (review R3b-02)', () => {
  const INVITED: PlatformPolicyShape = {
    accessMode: 'INVITED',
    rulesRequired: false,
    rulesLink: null,
    channelRequired: true,
    channelLink: 'https://t.me/operator_news',
    defaultCurrency: 'RUB',
  };
  const RESTRICTED: PlatformPolicyShape = { ...INVITED, accessMode: 'RESTRICTED' };
  const OFFER = { key: 'OFFER', title: 'Оферта', body: 'Текст' } as LegalDocument;
  const PRIVACY = { key: 'PRIVACY_POLICY', title: 'Политика', body: 'Текст' } as LegalDocument;
  const withButton = (label: string): BotConfig => ({
    ...DEFAULT_BOT_CONFIG,
    buttons: [{ id: 'shop', emoji: '', label, visible: true, order: 0, style: 'primary', onePerRow: true }],
  });
  const labels = (config: BotConfig): string[] => config.buttons.map((button) => button.label);

  /** A panel whose reads answer when the case says so — until then, never. */
  function hangingPanel<T>() {
    const waiting: Array<(value: T) => void> = [];
    const read = vi.fn(
      () =>
        new Promise<T>((resolve) => {
          waiting.push(resolve);
        }),
    );
    return {
      read,
      answer: (value: T): void => {
        for (const resolve of waiting.splice(0)) resolve(value);
      },
    };
  }

  /**
   * A Redis that is away the way ioredis reports it: a command fails once its
   * two-second command timeout is out (`REDIS_COMMAND_TIMEOUT_MS`), not at once.
   * `state.up` brings it back for the commands sent after it.
   */
  function hangingRedis(initial: Record<string, string>) {
    const data = new Map<string, string>(Object.entries(initial));
    const state = { up: false };
    const redis = {
      get: vi.fn((key: string) =>
        state.up
          ? Promise.resolve(data.get(key) ?? null)
          : new Promise<string | null>((_resolve, reject) => {
              setTimeout(() => reject(new Error('Command timed out')), 2_000);
            }),
      ),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 0),
    };
    return { redis, state };
  }

  /** What `promise` settles to — or a failure, if it needs any time to pass to settle. */
  async function answeredWithoutWaiting<T>(promise: Promise<T>): Promise<T> {
    const outcome: { settled: boolean; value?: T } = { settled: false };
    void promise.then((value) => {
      outcome.settled = true;
      outcome.value = value;
    });
    for (let turn = 0; turn < 50 && !outcome.settled; turn += 1) await Promise.resolve();
    if (!outcome.settled) throw new Error('the read waited');
    return outcome.value as T;
  }

  /** What `promise` settles to, checking that it took exactly `ms` fake milliseconds. */
  async function settledAfter<T>(promise: Promise<T>, ms: number): Promise<T> {
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    return promise;
  }

  it('PolicyCache: the operator’s INVITED at once after the pause, the panel read still out — then the panel’s answer', async () => {
    const { redis } = flakyRedis(await savedBefore(PLATFORM_POLICY_LKG, INVITED));
    const panel = hangingPanel<PlatformPolicyShape>();
    const cache = new PolicyCache(panel.read, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });

    // Nothing can be known yet: the stand-in once the budget is out, as before.
    expect((await settledAfter(cache.get(), POLICY_WAIT_BUDGET_MS))._isFallback).toBe(true);
    // Within the store's pause: the stand-in at once, and Redis is not asked.
    expect((await answeredWithoutWaiting(cache.get()))._isFallback).toBe(true);
    expect(redis.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LAST_KNOWN_GOOD_RETRY_MS);
    const policy = await answeredWithoutWaiting(cache.get());
    expect(policy).toEqual(INVITED);
    expect(policy._isFallback).toBeUndefined();
    // The one panel read, still out: nobody began another.
    expect(panel.read).toHaveBeenCalledTimes(1);

    panel.answer(RESTRICTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(await answeredWithoutWaiting(cache.get())).toEqual(RESTRICTED);
  });

  it('PolicyCache: a panel that gives up after a second and a half — the copy right after the store’s pause, not after the stand-in’s window', async () => {
    const { redis } = flakyRedis(await savedBefore(PLATFORM_POLICY_LKG, INVITED));
    const read = vi.fn(
      () =>
        new Promise<PlatformPolicyShape>((_resolve, reject) => {
          setTimeout(() => reject(new Error('UND_ERR_CONNECT_TIMEOUT')), 1_500);
        }),
    );
    const cache = new PolicyCache(read, { lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }) });

    expect((await settledAfter(cache.get(), POLICY_WAIT_BUDGET_MS))._isFallback).toBe(true);
    // 1.5 s: the read gives up while Redis is still in the store's pause; the
    // stand-in's own window runs to 3.5 s. 2.5 s: past the store's pause.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await answeredWithoutWaiting(cache.get())).toEqual(INVITED);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('PolicyCache: a Redis that hangs as well holds a read the budget at most, once per read of Redis — and the copy once Redis answers', async () => {
    const { redis, state } = hangingRedis(await savedBefore(PLATFORM_POLICY_LKG, INVITED));
    const cache = new PolicyCache(hangingPanel<PlatformPolicyShape>().read, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });

    // 0 s: the budget, on the panel and on the first read of Redis alike.
    expect((await settledAfter(cache.get(), POLICY_WAIT_BUDGET_MS))._isFallback).toBe(true);
    // 1 s: that read of Redis is still out, and a read has waited on it already.
    expect((await answeredWithoutWaiting(cache.get()))._isFallback).toBe(true);
    // 2.5 s: it failed at 2 s and the store pauses: at once, and Redis is not asked.
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await answeredWithoutWaiting(cache.get()))._isFallback).toBe(true);
    expect(redis.get).toHaveBeenCalledTimes(1);
    // 4.5 s: past the pause, a new read of Redis — waited for once, the budget at most.
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await settledAfter(cache.get(), POLICY_WAIT_BUDGET_MS))._isFallback).toBe(true);
    expect((await answeredWithoutWaiting(cache.get()))._isFallback).toBe(true);
    expect(redis.get).toHaveBeenCalledTimes(2);

    // Redis is back. The read sent while it was away fails at 6.5 s all the
    // same, and the store's pause after it ends at 8.5 s.
    state.up = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await answeredWithoutWaiting(cache.get())).toEqual(INVITED);
    expect(redis.get).toHaveBeenCalledTimes(3);
  });

  it('PolicyCache: an operator’s change while the copy is on its way — that read still gets the copy, not PUBLIC', async () => {
    // Redis's first read fails; the ones after it answer in 300 ms.
    const data = new Map<string, string>(Object.entries(await savedBefore(PLATFORM_POLICY_LKG, INVITED)));
    let reads = 0;
    const redis = {
      get: vi.fn(async (key: string) => {
        reads += 1;
        if (reads === 1) throw new Error('Command timed out');
        await new Promise((resolve) => setTimeout(resolve, 300));
        return data.get(key) ?? null;
      }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 0),
    };
    const cache = new PolicyCache(hangingPanel<PlatformPolicyShape>().read, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });
    expect((await settledAfter(cache.get(), POLICY_WAIT_BUDGET_MS))._isFallback).toBe(true);
    await vi.advanceTimersByTimeAsync(LAST_KNOWN_GOOD_RETRY_MS);

    const read = cache.get();
    await vi.advanceTimersByTimeAsync(100);
    // The copy lands in a generation of its own now, so it is not held for this
    // read — which is still answered with it.
    cache.invalidate();
    await vi.advanceTimersByTimeAsync(200);
    expect(await read).toEqual(INVITED);
    // The first read after the change holds it, the change's own panel read out.
    expect(await answeredWithoutWaiting(cache.get())).toEqual(INVITED);
  });

  it('BotConfigCache: the operator’s buttons at once after the pause, the panel read still out — then the panel’s answer', async () => {
    const { redis } = flakyRedis(await savedBefore(BOT_CONFIG_LKG, withButton('Operator button')));
    const panel = hangingPanel<BotConfig>();
    const cache = new BotConfigCache({
      fetcher: panel.read,
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
      persistence: new RedisConfigPersistence(new RedisLastKnownGoodStore({ redis: redis as never })),
    });

    expect(await settledAfter(cache.get(), FIRST_LOAD_BUDGET_MS)).toBe(DEFAULT_BOT_CONFIG);
    expect(await answeredWithoutWaiting(cache.get())).toBe(DEFAULT_BOT_CONFIG);
    expect(redis.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LAST_KNOWN_GOOD_RETRY_MS);
    expect(labels(await answeredWithoutWaiting(cache.get()))).toEqual(['Operator button']);
    // What the replies that cannot wait for the panel render from.
    expect(cache.peek()?.buttons[0]?.label).toBe('Operator button');
    expect(panel.read).toHaveBeenCalledTimes(1);

    panel.answer(withButton('Panel button'));
    await vi.advanceTimersByTimeAsync(0);
    expect(labels(await answeredWithoutWaiting(cache.get()))).toEqual(['Panel button']);
  });

  it('BotConfigCache: a panel that refuses and a Redis that hangs — reads in the hold-off wait the budget at most, once per read of Redis', async () => {
    const { redis, state } = hangingRedis(await savedBefore(BOT_CONFIG_LKG, withButton('Operator button')));
    const cache = new BotConfigCache({
      fetcher: panelDown,
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
      persistence: new RedisConfigPersistence(new RedisLastKnownGoodStore({ redis: redis as never })),
    });

    // 0 s: the panel refuses — its ten-second hold-off begins — and the first
    // read of Redis does not answer within the budget.
    expect(await settledAfter(cache.get(), FIRST_LOAD_BUDGET_MS)).toBe(DEFAULT_BOT_CONFIG);
    // 1 s: that read of Redis is still out, and a read has waited on it already.
    expect(await answeredWithoutWaiting(cache.get())).toBe(DEFAULT_BOT_CONFIG);
    // 4.5 s: it failed at 2 s, the store's pause is over — a new read of
    // Redis, waited for once, the budget at most (not its two seconds).
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await settledAfter(cache.get(), FIRST_LOAD_BUDGET_MS)).toBe(DEFAULT_BOT_CONFIG);
    expect(await answeredWithoutWaiting(cache.get())).toBe(DEFAULT_BOT_CONFIG);
    expect(redis.get).toHaveBeenCalledTimes(2);

    // Redis is back; the read sent while it was away fails at 6.5 s, and the
    // pause after it ends at 8.5 s — still within the hold-off.
    state.up = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(labels(await answeredWithoutWaiting(cache.get()))).toEqual(['Operator button']);
  });

  it('LegalDocumentsCache: «Правила» gets the saved documents at once after the pause, the panel read still out — then the panel’s answer', async () => {
    const { redis } = flakyRedis(await savedBefore(legalDocumentsLastKnownGood('ru'), [OFFER]));
    const panel = hangingPanel<readonly LegalDocument[]>();
    const cache = new LegalDocumentsCache(panel.read, 60_000, LEGAL_DOCUMENTS_WAIT_BUDGET_MS, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });

    expect(await settledAfter(cache.get('ru'), LEGAL_DOCUMENTS_WAIT_BUDGET_MS)).toEqual([]);
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual([]);
    expect(redis.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LAST_KNOWN_GOOD_RETRY_MS);
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual([OFFER]);
    expect(panel.read).toHaveBeenCalledTimes(1);

    panel.answer([OFFER, PRIVACY]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual([OFFER, PRIVACY]);
  });

  it('LegalDocumentsCache: a Redis that hangs as well holds a tap the budget at most, once per read of Redis', async () => {
    const { redis, state } = hangingRedis(await savedBefore(legalDocumentsLastKnownGood('ru'), [OFFER]));
    const cache = new LegalDocumentsCache(hangingPanel<readonly LegalDocument[]>().read, 60_000, LEGAL_DOCUMENTS_WAIT_BUDGET_MS, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });

    expect(await settledAfter(cache.get('ru'), LEGAL_DOCUMENTS_WAIT_BUDGET_MS)).toEqual([]);
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await settledAfter(cache.get('ru'), LEGAL_DOCUMENTS_WAIT_BUDGET_MS)).toEqual([]);
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual([]);
    expect(redis.get).toHaveBeenCalledTimes(2);

    state.up = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual([OFFER]);
  });
});

/**
 * A "none" from Redis is true when it is given — but not for the life of the
 * process. The API and the bot keep their copies in the same Redis, and a
 * container is replaced while the old one still runs: a process that read
 * "none" at boot answered from it until the panel answered it itself, with a
 * copy saved beside it a moment later — the PUBLIC stand-in, the legacy rules
 * link, the guest chat without its captcha. A "none" is asked again once half
 * a minute has passed; within it, Redis is not asked.
 */
describe('a "none" from Redis is asked again after half a minute, never sooner', () => {
  const INVITED: PlatformPolicyShape = {
    accessMode: 'INVITED',
    rulesRequired: false,
    rulesLink: null,
    channelRequired: true,
    channelLink: 'https://t.me/operator_news',
    defaultCurrency: 'RUB',
  };
  const OFFER = { key: 'OFFER', title: 'Оферта', body: 'Текст' } as LegalDocument;
  const WITH_CAPTCHA: GuestRuntimeConfig = {
    enabled: true,
    turnstileSiteKey: '0x4AAAAAAAsite',
    turnstileSecret: '0x4AAAAAAAsecret',
  };
  // Literal on purpose: a fixture read from the constant would move with it.
  const HALF_A_MINUTE = 30_000;

  it('trusts a "none" for half a minute', () => {
    expect(LAST_KNOWN_GOOD_NONE_RECHECK_MS).toBe(HALF_A_MINUTE);
  });

  /** One Redis, and another process that saves into it. */
  function sharedRedis() {
    const { redis } = flakyRedis({}, 0);
    return { redis, otherProcess: new RedisLastKnownGoodStore({ redis: redis as never }) };
  }

  it('PolicyCache: PUBLIC while there is none — the operator’s INVITED once the API has saved it and the half minute is over', async () => {
    const { redis, otherProcess } = sharedRedis();
    const cache = new PolicyCache(panelDown, { lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }) });
    expect((await cache.get())._isFallback).toBe(true);
    expect((await cache.get())._isFallback).toBe(true);
    const reads = redis.get.mock.calls.length;

    await otherProcess.save(PLATFORM_POLICY_LKG, { ...INVITED });
    await vi.advanceTimersByTimeAsync(HALF_A_MINUTE - 1);
    expect((await cache.get())._isFallback).toBe(true);
    expect(redis.get.mock.calls.length).toBe(reads);

    await vi.advanceTimersByTimeAsync(1);
    expect(await cache.get()).toEqual(INVITED);
  });

  it('LegalDocumentsCache: «Правила» on the legacy link while there is none — the documents once saved beside it and the half minute is over', async () => {
    const { redis, otherProcess } = sharedRedis();
    const cache = new LegalDocumentsCache(panelDown, 60_000, 50, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
    });
    expect(await cache.get('ru')).toEqual([]);
    const reads = redis.get.mock.calls.length;

    await otherProcess.save(legalDocumentsLastKnownGood('ru'), [OFFER]);
    await vi.advanceTimersByTimeAsync(HALF_A_MINUTE - 1);
    expect(await cache.get('ru')).toEqual([]);
    expect(redis.get.mock.calls.length).toBe(reads);

    await vi.advanceTimersByTimeAsync(1);
    expect(await cache.get('ru')).toEqual([OFFER]);
  });

  it('GuestSupportConfigCache: no captcha while there is none — the captcha once the API has saved it and the half minute is over', async () => {
    const { redis, otherProcess } = sharedRedis();
    const cache = new GuestSupportConfigCache(panelDown, {
      lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
      ttlMs: 30_000,
    });
    expect(await cache.get()).toBeNull();
    const reads = redis.get.mock.calls.length;

    await otherProcess.save(GUEST_SUPPORT_LKG, { ...WITH_CAPTCHA });
    await vi.advanceTimersByTimeAsync(HALF_A_MINUTE - 1);
    expect(await cache.get()).toBeNull();
    expect(redis.get.mock.calls.length).toBe(reads);

    await vi.advanceTimersByTimeAsync(1);
    expect(await cache.get()).toEqual(WITH_CAPTCHA);
  });
});
