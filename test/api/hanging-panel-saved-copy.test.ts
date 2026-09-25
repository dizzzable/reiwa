import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';
import {
  createBrandingRouter,
  getCustomEmojiPacks,
  getPublicConfigPayload,
  resetBrandingCache,
} from '../../src/api/routes/branding.js';
import { getConnectPageCatalog, resetConnectPageCache } from '../../src/api/routes/connect-page.js';
import { createLandingRouter, getEffectiveLandingCached, resetLandingCache } from '../../src/api/routes/landing.js';
import { GuestSupportConfigCache } from '../../src/infrastructure/admin-client/guest-support-config-cache.js';
import {
  CUSTOM_EMOJI_PACKS_LKG,
  GUEST_SUPPORT_LKG,
  LANDING_LKG,
  LAST_KNOWN_GOOD_RETRY_MS,
  LAST_KNOWN_GOOD_UNREADABLE,
  RedisLastKnownGoodStore,
  type LastKnownGoodGroup,
} from '../../src/infrastructure/config-versions/last-known-good.js';
import { PANEL_HEAD_START_MS, panelOrSavedCopy } from '../../src/infrastructure/config-versions/panel-or-saved-copy.js';
import {
  CONNECT_PAGE_LKG,
  RedisConnectPageSnapshot,
} from '../../src/infrastructure/public-config/redis-connect-page-snapshot.js';
import {
  PUBLIC_CONFIG_LKG,
  RedisPublicConfigPersistence,
} from '../../src/infrastructure/public-config/redis-public-config-persistence.js';

/**
 * The API's settings readers with a panel that HANGS — its VPS down, packets
 * dropped, so a read waits out the transport's ten seconds instead of failing
 * at once (review R3b-02, on the API side).
 *
 * The landing, the appearance and its emoji packs, the connect screen and the
 * guest chat's config asked for their copy in Redis only once the panel read
 * had failed: the first visitors after a restart waited the ten seconds, and
 * the landing and the connect screen made the visitors of one window per TTL
 * wait them again all through an outage. Now:
 *  - nothing held: the panel gets its head start, then the saved copy is served
 *    while the read goes on — and the panel's answer replaces it when it comes;
 *  - the panel answering within its head start (the read after an operator's
 *    save) is answered with — never the older copy;
 *  - a Redis that could not be read is asked again after the store's pause;
 *    with no copy saved, the panel is waited for, as before;
 *  - held past its TTL: served at once while the read refreshes it.
 *
 * Each reader goes through the REAL store over an in-memory Redis.
 */

/**
 * An in-memory Redis whose first `failures` GETs fail the way ioredis does, and
 * whose GETs answer `delayMs` after they are sent.
 */
function memoryRedis(initial: Record<string, string> = {}, failures = 0, delayMs = 0) {
  const data = new Map<string, string>(Object.entries(initial));
  let failuresLeft = failures;
  return {
    get: vi.fn(async (key: string) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('Command timed out');
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return data.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
}

/** What a previous process left in Redis for `group`. */
async function savedBefore(group: LastKnownGoodGroup<never>, payload: unknown): Promise<Record<string, string>> {
  const redis = memoryRedis();
  await new RedisLastKnownGoodStore({ redis: redis as never }).save(group, payload as never);
  const entries: Record<string, string> = {};
  for (const [key] of redis.set.mock.calls) entries[key as string] = (await redis.get(key as string)) as string;
  return entries;
}

/** A panel whose reads answer only when the case says so — until then, never. */
function panel<T>() {
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

/** What `promise` settles to, checking that it took exactly `ms` fake milliseconds. */
async function settledAfter<T>(promise: Promise<T>, ms: number): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  return promise;
}

/** What `promise` settles to — or a failure, if it needs any time to pass to settle. */
async function answeredWithoutWaiting<T>(promise: Promise<T>): Promise<T> {
  const outcome: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    outcome.settled = true;
    outcome.value = value;
  });
  for (let turn = 0; turn < 100 && !outcome.settled; turn += 1) await Promise.resolve();
  if (!outcome.settled) throw new Error('the read waited');
  return outcome.value as T;
}

const SNAPSHOT: PublicConfigSnapshot = {
  branding: {
    brandName: 'Northern Lights VPN',
    logoUrl: null,
    primary: '#6750a4',
    primaryFg: '#ffffff',
    bgPrimary: '#121212',
    bgSecondary: '#242424',
    cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
    cardPattern: null,
    cardLogo: 'DEFAULT',
    cardLogoUrl: null,
    cardEffect: 'aurora',
    cardEffectProps: {},
    cardEffectOpacity: 0.7,
    cardEffectsByIndex: [],
    bgEffect: 'AURORA',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-xl',
    fontFamily: 'Manrope, sans-serif',
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [],
};

/** One reader: how to build it over a store and a panel, and what it serves. */
interface Reader {
  readonly name: string;
  readonly group: LastKnownGoodGroup<never>;
  /** The copy a previous process saved. */
  readonly saved: unknown;
  /** What the panel answers now — not the copy. */
  readonly answered: unknown;
  /**
   * A reader over this Redis and this panel read: `get` resolves to the body
   * served; `reset` is what an operator's save does to it (the invalidate).
   */
  build(
    redis: ReturnType<typeof memoryRedis>,
    read: () => Promise<unknown>,
  ): { readonly get: () => Promise<unknown>; readonly reset: () => void };
}

const READERS: readonly Reader[] = [
  {
    name: 'the landing',
    group: LANDING_LKG as LastKnownGoodGroup<never>,
    saved: { schemaVersion: 1, enabled: true, defaultLocale: 'ru', sections: [], meta: { title: { ru: 'Сохранённый' } } },
    answered: { schemaVersion: 1, enabled: true, defaultLocale: 'ru', sections: [], meta: { title: { ru: 'Из панели' } } },
    build: (redis, read) => {
      const adminClient = { landing: { getEffective: read } } as never;
      createLandingRouter({ adminClient, lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }) });
      return { get: () => getEffectiveLandingCached(adminClient), reset: resetLandingCache };
    },
  },
  {
    name: 'the appearance (public config)',
    group: PUBLIC_CONFIG_LKG as LastKnownGoodGroup<never>,
    saved: SNAPSHOT,
    answered: { ...SNAPSHOT, defaultCurrency: 'RUB' },
    build: (redis, read) => {
      const adminClient = { branding: { getReiwaPublicConfig: read } } as never;
      const persistence = new RedisPublicConfigPersistence({
        redis: {} as never,
        store: new RedisLastKnownGoodStore({ redis: redis as never }),
      });
      return {
        get: async () => (await getPublicConfigPayload(adminClient, undefined, persistence)).body,
        reset: resetBrandingCache,
      };
    },
  },
  {
    name: 'the custom emoji packs',
    group: CUSTOM_EMOJI_PACKS_LKG as LastKnownGoodGroup<never>,
    saved: [{ id: 'saved-pack', emojis: [] }],
    answered: [{ id: 'panel-pack', emojis: [] }],
    build: (redis, read) => {
      const adminClient = { branding: { getCustomEmojiPacks: read } } as never;
      createBrandingRouter({ adminClient, lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }) });
      return { get: async () => (await getCustomEmojiPacks(adminClient)).body, reset: resetBrandingCache };
    },
  },
  {
    name: 'the connect screen',
    group: CONNECT_PAGE_LKG as LastKnownGoodGroup<never>,
    saved: { version: 2, platforms: [{ id: 'saved' }], icons: {}, showConnectionKeys: false },
    answered: { version: 2, platforms: [{ id: 'panel' }], icons: {}, showConnectionKeys: false },
    build: (redis, read) => {
      const adminClient = { connectPage: { getEffective: read } } as never;
      const snapshots = new RedisConnectPageSnapshot({
        redis: {} as never,
        store: new RedisLastKnownGoodStore({ redis: redis as never }),
      });
      return { get: async () => (await getConnectPageCatalog(adminClient, snapshots)).body, reset: resetConnectPageCache };
    },
  },
  {
    name: 'the guest chat’s config',
    group: GUEST_SUPPORT_LKG as LastKnownGoodGroup<never>,
    saved: { enabled: true, turnstileSiteKey: '0xSAVED-site', turnstileSecret: '0xSAVED-secret' },
    answered: { enabled: true, turnstileSiteKey: '0xPANEL-site', turnstileSecret: '0xPANEL-secret' },
    build: (redis, read) => {
      const cache = new GuestSupportConfigCache(read as never, {
        lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
      });
      return { get: () => cache.get(), reset: () => cache.invalidate() };
    },
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetLandingCache();
  resetBrandingCache();
  resetConnectPageCache();
});

afterEach(() => {
  resetLandingCache();
  resetBrandingCache();
  resetConnectPageCache();
  vi.useRealTimers();
});

describe.each(READERS)('$name with a panel that hangs (review R3b-02, API side)', (reader) => {
  it('a restart: the saved copy once the panel’s head start is out — not when its read gives up — then the panel’s answer', async () => {
    const redis = memoryRedis(await savedBefore(reader.group, reader.saved));
    const upstream = panel<unknown>();
    const { get } = reader.build(redis, upstream.read);

    expect(await settledAfter(get(), PANEL_HEAD_START_MS)).toEqual(reader.saved);
    // Held: the next visitor gets it at once, and the one panel read is still out.
    expect(await answeredWithoutWaiting(get())).toEqual(reader.saved);
    expect(upstream.read).toHaveBeenCalledTimes(1);

    upstream.answer(reader.answered);
    await vi.advanceTimersByTimeAsync(0);
    expect(await answeredWithoutWaiting(get())).toEqual(reader.answered);
  });

  it('a panel that answers within its head start — the read after an operator’s save — is answered with, not the older copy', async () => {
    const redis = memoryRedis(await savedBefore(reader.group, reader.saved));
    const upstream = panel<unknown>();
    const { get } = reader.build(redis, upstream.read);

    const read = get();
    setTimeout(() => upstream.answer(reader.answered), 100);
    expect(await settledAfter(read, 100)).toEqual(reader.answered);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('a Redis that could not be read at first: the copy right after the store’s pause, the panel read still out', async () => {
    const redis = memoryRedis(await savedBefore(reader.group, reader.saved), 1);
    const upstream = panel<unknown>();
    const { get } = reader.build(redis, upstream.read);

    expect(await settledAfter(get(), PANEL_HEAD_START_MS + LAST_KNOWN_GOOD_RETRY_MS)).toEqual(reader.saved);
    expect(upstream.read).toHaveBeenCalledTimes(1);
  });

  it('an operator’s save while the copy is on its way: the copy is not held after it — the next read asks again', async () => {
    // Redis answers 300 ms after it is asked.
    const redis = memoryRedis(await savedBefore(reader.group, reader.saved), 0, 300);
    const upstream = panel<unknown>();
    const { get, reset } = reader.build(redis, upstream.read);

    const before = get();
    await vi.advanceTimersByTimeAsync(PANEL_HEAD_START_MS + 100);
    reset();
    await vi.advanceTimersByTimeAsync(200);
    // Begun before the save, it is still answered with the copy it read...
    expect(await before).toEqual(reader.saved);
    // ...but nothing of it is held: the next read is a cold one of its own —
    // not answered at once, and its own panel read goes out.
    const next = get();
    await expect(answeredWithoutWaiting(next)).rejects.toThrow('the read waited');
    expect(upstream.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PANEL_HEAD_START_MS + 300);
    expect(await next).toEqual(reader.saved);
  });

  it('with no copy saved, the panel is waited for, as before — nothing stands in for it', async () => {
    const redis = memoryRedis();
    const upstream = panel<unknown>();
    const { get } = reader.build(redis, upstream.read);

    const read = get();
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe(false);
    upstream.answer(reader.answered);
    expect(await read).toEqual(reader.answered);
  });
});

/**
 * Held past its TTL, a panel that hangs used to hold the read — every visitor of
 * one window per TTL, all through an outage (the appearance has five minutes of
 * stale-while-revalidate, then did the same, and the packs never did).
 */
describe('a copy held past its TTL, with the panel hanging', () => {
  /** A panel that answers `first` at once, and hangs from then on. */
  function answersOnce<T>(first: T) {
    let answered = false;
    return vi.fn(
      () =>
        new Promise<T>((resolve) => {
          if (!answered) {
            answered = true;
            resolve(first);
          }
        }),
    );
  }

  it('the landing: served at once while one read refreshes it', async () => {
    const landing = { schemaVersion: 1, enabled: true, defaultLocale: 'ru', sections: [] };
    const read = answersOnce<unknown>(landing);
    const adminClient = { landing: { getEffective: read } } as never;
    createLandingRouter({ adminClient, lastKnownGood: new RedisLastKnownGoodStore({ redis: memoryRedis() as never }) });
    expect(await getEffectiveLandingCached(adminClient)).toEqual(landing);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await answeredWithoutWaiting(getEffectiveLandingCached(adminClient))).toEqual(landing);
    expect(await answeredWithoutWaiting(getEffectiveLandingCached(adminClient))).toEqual(landing);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('the connect screen: served at once while one read refreshes it', async () => {
    const catalog = { version: 2, platforms: [], icons: {}, showConnectionKeys: false };
    const read = answersOnce<unknown>(catalog);
    const adminClient = { connectPage: { getEffective: read } } as never;
    const snapshots = new RedisConnectPageSnapshot({
      redis: {} as never,
      store: new RedisLastKnownGoodStore({ redis: memoryRedis() as never }),
    });
    expect((await getConnectPageCatalog(adminClient, snapshots)).body).toEqual(catalog);

    await vi.advanceTimersByTimeAsync(60_000);
    expect((await answeredWithoutWaiting(getConnectPageCatalog(adminClient, snapshots))).body).toEqual(catalog);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('the appearance past its five minutes of stale-while-revalidate: what it holds once the head start is out', async () => {
    const read = answersOnce<unknown>(SNAPSHOT);
    const adminClient = { branding: { getReiwaPublicConfig: read } } as never;
    expect((await getPublicConfigPayload(adminClient)).body).toEqual(SNAPSHOT);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await settledAfter(getPublicConfigPayload(adminClient), PANEL_HEAD_START_MS)).body).toEqual(SNAPSHOT);
  });

  it('the packs past the stand-in’s pause: not the empty list for the read’s ten seconds — the copy', async () => {
    // Redis could not be read when the panel failed: the empty list stands in
    // for the store's pause. After it, the panel hangs and Redis answers.
    const redis = memoryRedis(await savedBefore(CUSTOM_EMOJI_PACKS_LKG as never, [{ id: 'saved-pack' }]), 1);
    let calls = 0;
    const read = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('connect ECONNREFUSED')) : new Promise<never>(() => undefined);
    });
    const adminClient = { branding: { getCustomEmojiPacks: read } } as never;
    createBrandingRouter({ adminClient, lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }) });
    expect((await getCustomEmojiPacks(adminClient)).body).toEqual([]);

    await vi.advanceTimersByTimeAsync(LAST_KNOWN_GOOD_RETRY_MS);
    expect((await settledAfter(getCustomEmojiPacks(adminClient), PANEL_HEAD_START_MS)).body).toEqual([{ id: 'saved-pack' }]);
  });
});

describe('panelOrSavedCopy', () => {
  it('asks again after each unreadable answer, a pause apart — never in a loop — and takes the panel’s answer the moment it lands', async () => {
    const upstream = panel<string>();
    const instead = vi.fn(async (): Promise<string | null | typeof LAST_KNOWN_GOOD_UNREADABLE> => LAST_KNOWN_GOOD_UNREADABLE);
    const read = panelOrSavedCopy({ panel: upstream.read(), instead, headStartMs: 1_000, retryMs: 2_000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(instead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(instead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(instead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(instead).toHaveBeenCalledTimes(2);
    upstream.answer('panel');
    expect(await read).toBe('panel');
    expect(instead).toHaveBeenCalledTimes(2);
  });

  it('a panel answer that lands while Redis is still being asked wins over the copy', async () => {
    const upstream = panel<string>();
    const instead = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('copy'), 300);
        }),
    );
    const read = panelOrSavedCopy({ panel: upstream.read(), instead, headStartMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(instead).toHaveBeenCalledTimes(1);
    upstream.answer('panel');
    await vi.advanceTimersByTimeAsync(200);
    expect(await read).toBe('panel');
  });

  it('a panel read that fails within the head start fails the read, as it did — nothing stands in for a refusal', async () => {
    const instead = vi.fn(async () => 'copy');
    await expect(
      panelOrSavedCopy({ panel: Promise.reject(new Error('refused')), instead, headStartMs: 1_000 }),
    ).rejects.toThrow('refused');
    expect(instead).not.toHaveBeenCalled();
  });
});
