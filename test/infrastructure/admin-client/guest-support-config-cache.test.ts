import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GuestSupportConfigCache,
} from '../../../src/infrastructure/admin-client/guest-support-config-cache.js';
import type { GuestRuntimeConfig } from '../../../src/infrastructure/admin-client/namespaces/support.js';
import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import type {
  LastKnownGood,
  LastKnownGoodStorePort,
} from '../../../src/infrastructure/config-versions/last-known-good.js';

/**
 * The guest chat's runtime config (W8 report D13). A cold start with the panel
 * down used to answer "enabled, no captcha": the form rendered without the
 * captcha, and once the panel was back every conversation it sent was refused
 * `captcha_failed`. The copy in Redis keeps the captcha — secret included —
 * through a restart.
 */

const WITH_CAPTCHA: GuestRuntimeConfig = {
  enabled: true,
  turnstileSiteKey: '0x4AAAAAAAsite',
  turnstileSecret: '0x4AAAAAAAsecret',
};

function savedCopy(saved: GuestRuntimeConfig | null) {
  const saves: unknown[] = [];
  const record: LastKnownGood<Record<string, unknown>> | null =
    saved === null ? null : { shape: 1, savedAt: 1, hash: configVersionOf(saved), payload: { ...saved } };
  const store: LastKnownGoodStorePort = {
    load: vi.fn(async () => record) as LastKnownGoodStorePort['load'],
    save: vi.fn(async (_group: unknown, payload: unknown) => {
      saves.push(payload);
    }) as LastKnownGoodStorePort['save'],
  };
  return { store, saves };
}

function handAnswered() {
  const calls: Array<{ resolve: (value: GuestRuntimeConfig) => void; reject: (reason: unknown) => void }> = [];
  const fn = vi.fn(
    () =>
      new Promise<GuestRuntimeConfig>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return {
    fn,
    answer: (index: number, value: GuestRuntimeConfig): void => (calls[index] as (typeof calls)[number]).resolve(value),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GuestSupportConfigCache', () => {
  it('a restart with the panel down keeps the captcha: the saved config, secret included', async () => {
    const { store } = savedCopy(WITH_CAPTCHA);
    const cache = new GuestSupportConfigCache(
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      { lastKnownGood: store },
    );

    expect(await cache.get()).toEqual(WITH_CAPTCHA);
    expect(cache.heldVersion()).toBe(configVersionOf(WITH_CAPTCHA));
  });

  it('answers null only when no config was ever known, and remembers that for the TTL', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async (): Promise<GuestRuntimeConfig> => {
      throw new Error('connect ECONNREFUSED');
    });
    const { store } = savedCopy(null);
    const cache = new GuestSupportConfigCache(fetchFn, { lastKnownGood: store, ttlMs: 30_000 });

    expect(await cache.get()).toBeNull();
    expect(await cache.get()).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(await cache.get()).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('saves every config the panel answers, and serves it stale while one refresh runs', async () => {
    vi.useFakeTimers();
    const upstream = handAnswered();
    const { store, saves } = savedCopy(null);
    const cache = new GuestSupportConfigCache(upstream.fn, { lastKnownGood: store, ttlMs: 30_000 });
    const first = cache.get();
    upstream.answer(0, WITH_CAPTCHA);
    expect(await first).toEqual(WITH_CAPTCHA);
    expect(saves).toEqual([WITH_CAPTCHA]);

    vi.advanceTimersByTime(30_000);
    // Stale: answered at once; the refresh is still unanswered.
    expect(await cache.get()).toEqual(WITH_CAPTCHA);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
  });

  it('a read begun before invalidate() does not land the old config after it', async () => {
    const upstream = handAnswered();
    const { store, saves } = savedCopy(null);
    const cache = new GuestSupportConfigCache(upstream.fn, { lastKnownGood: store });
    const NO_CAPTCHA: GuestRuntimeConfig = { enabled: true, turnstileSiteKey: '', turnstileSecret: null };

    const before = cache.get();
    cache.invalidate();
    const after = cache.get();
    upstream.answer(1, WITH_CAPTCHA);
    expect(await after).toEqual(WITH_CAPTCHA);
    upstream.answer(0, NO_CAPTCHA); // the old read lands last
    await before;

    expect(await cache.get()).toEqual(WITH_CAPTCHA);
    expect(saves).toEqual([WITH_CAPTCHA]);
  });

  it('keeps what it holds across invalidate(), so a page never loses the captcha between two reads', async () => {
    const upstream = handAnswered();
    const cache = new GuestSupportConfigCache(upstream.fn);
    const first = cache.get();
    upstream.answer(0, WITH_CAPTCHA);
    await first;

    cache.invalidate();
    expect(await cache.get()).toEqual(WITH_CAPTCHA);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
  });

  it('reads an answer without the keys it needs as a failed read', async () => {
    const { store } = savedCopy(WITH_CAPTCHA);
    const cache = new GuestSupportConfigCache(async () => ({ enabled: true }) as unknown as GuestRuntimeConfig, {
      lastKnownGood: store,
    });
    expect(await cache.get()).toEqual(WITH_CAPTCHA);
  });
});
