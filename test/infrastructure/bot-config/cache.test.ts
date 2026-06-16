/**
 * BotConfigCache specs.
 *
 *   - first call hits the fetcher; subsequent calls within ttlMs reuse the cache
 *   - cache expires after ttlMs and the next call refetches
 *   - hydrator.setOverrides is invoked on every successful refresh
 *   - fetcher errors fall back to the previous entry when available
 *   - fetcher errors fall back to the supplied `fallback` when nothing
 *     has ever been cached
 *   - hydrator throws are swallowed (don't poison the cache)
 *   - reset() drops the entry so the next call refetches
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BotConfigCache,
  DEFAULT_BOT_CONFIG,
} from '../../../src/infrastructure/bot-config/cache.js';
import type { LocalePackHydrator } from '../../../src/application/ports/translator.port.js';
import type { ConfigPersistencePort } from '../../../src/application/ports/config-persistence.port.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';

const SAMPLE: BotConfig & { translations: Record<string, string> } = {
  ...DEFAULT_BOT_CONFIG,
  translations: { 'en.menu.choose_action': 'Pick something' },
};

interface Spy {
  hydrator: LocalePackHydrator;
  calls: Array<Readonly<Record<string, string>> | null | undefined>;
  failNext: boolean;
}

function spyHydrator(): Spy {
  const calls: Spy['calls'] = [];
  const spy: Spy = {
    calls,
    failNext: false,
    hydrator: {
      setOverrides(map) {
        if (spy.failNext) {
          spy.failNext = false;
          throw new Error('boom: hydrator');
        }
        calls.push(map);
      },
    },
  };
  return spy;
}

describe('BotConfigCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the fetcher on first get()', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    const cache = new BotConfigCache({ fetcher, hydrator: spy.hydrator, fallback: DEFAULT_BOT_CONFIG });
    const out = await cache.get();
    expect(out).toBe(SAMPLE);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reuses the cache within ttlMs', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      ttlMs: 10_000,
    });
    await cache.get();
    vi.advanceTimersByTime(5_000);
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches after ttlMs expires', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      ttlMs: 10_000,
    });
    await cache.get();
    vi.advanceTimersByTime(11_000);
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('hydrates the translator on every successful refresh', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      ttlMs: 10_000,
    });
    await cache.get();
    vi.advanceTimersByTime(11_000);
    await cache.get();
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]).toEqual(SAMPLE.translations);
  });

  it('falls back to the previous entry when the fetcher errors', async () => {
    let fail = false;
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('upstream down');
      return SAMPLE;
    });
    const spy = spyHydrator();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      ttlMs: 10_000,
    });
    await cache.get();
    fail = true;
    vi.advanceTimersByTime(11_000);
    const out = await cache.get();
    expect(out).toBe(SAMPLE);
  });

  it('falls back to the supplied fallback when nothing has been cached yet', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('cold-start error');
    });
    const spy = spyHydrator();
    const cache = new BotConfigCache({ fetcher, hydrator: spy.hydrator, fallback: DEFAULT_BOT_CONFIG });
    const out = await cache.get();
    expect(out).toBe(DEFAULT_BOT_CONFIG);
  });

  it('swallows hydrator errors so the cache still serves the data', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    spy.failNext = true;
    const cache = new BotConfigCache({ fetcher, hydrator: spy.hydrator, fallback: DEFAULT_BOT_CONFIG });
    const out = await cache.get();
    expect(out).toBe(SAMPLE);
  });

  it('reset() drops the cached entry so the next get() refetches', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      ttlMs: 60_000,
    });
    await cache.get();
    cache.reset();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('BotConfigCache persistence (Workstream 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface FakeStore {
    port: ConfigPersistencePort;
    saved: BotConfig[];
    stored: BotConfig | null;
    throwOnSave: boolean;
    throwOnLoad: boolean;
  }

  function fakeStore(initial: BotConfig | null = null): FakeStore {
    const s: FakeStore = {
      saved: [],
      stored: initial,
      throwOnSave: false,
      throwOnLoad: false,
      port: {
        async load() {
          if (s.throwOnLoad) throw new Error('boom: load');
          return s.stored;
        },
        async save(config) {
          if (s.throwOnSave) throw new Error('boom: save');
          s.saved.push(config);
          s.stored = config;
        },
      },
    };
    return s;
  }

  // Property 7: a successful fetch persists a fresh snapshot.
  it('persists the config on a successful fetch', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    const store = fakeStore();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    await cache.get();
    await vi.runAllTimersAsync();
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toBe(SAMPLE);
  });

  // Property 7: cold-start fetch failure seeds from persistence, not default.
  it('seeds from persistence on a cold-start fetch failure', async () => {
    const persisted: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      visual: { ...DEFAULT_BOT_CONFIG.visual, botDescription: 'persisted' },
    };
    const fetcher = vi.fn(async () => {
      throw new Error('upstream down');
    });
    const spy = spyHydrator();
    const store = fakeStore(persisted);
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    const out = await cache.get();
    expect(out).toBe(persisted);
    expect(out).not.toBe(DEFAULT_BOT_CONFIG);
  });

  // Property 7: empty persistence on cold-start failure → hardcoded default.
  it('falls back to the default when persistence is empty', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('upstream down');
    });
    const spy = spyHydrator();
    const store = fakeStore(null);
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    const out = await cache.get();
    expect(out).toBe(DEFAULT_BOT_CONFIG);
  });

  // Property 8: a store outage is non-fatal (save throws → still serves data).
  it('serves the fetched config even when persistence.save throws', async () => {
    const fetcher = vi.fn(async () => SAMPLE);
    const spy = spyHydrator();
    const store = fakeStore();
    store.throwOnSave = true;
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    const out = await cache.get();
    expect(out).toBe(SAMPLE);
    await vi.runAllTimersAsync();
  });

  // Property 8: load throwing on cold-start failure degrades to default.
  it('falls back to the default when persistence.load throws', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('upstream down');
    });
    const spy = spyHydrator();
    const store = fakeStore();
    store.throwOnLoad = true;
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    const out = await cache.get();
    expect(out).toBe(DEFAULT_BOT_CONFIG);
  });

  // Property 8: a resolved banner file_id is stamped + re-persisted.
  it('stampBannerFileId stamps the file_id and re-persists', async () => {
    const withBanner: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      visual: { ...DEFAULT_BOT_CONFIG.visual, bannerUrl: 'https://x/banner.jpg' },
    };
    const fetcher = vi.fn(async () => withBanner);
    const spy = spyHydrator();
    const store = fakeStore();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    await cache.get();
    cache.stampBannerFileId('https://x/banner.jpg', 'FILE_ID_123');
    await vi.runAllTimersAsync();
    const last = store.saved[store.saved.length - 1];
    expect(last.visual.bannerFileId).toBe('FILE_ID_123');
    const out = await cache.get();
    expect(out.visual.bannerFileId).toBe('FILE_ID_123');
  });

  // Property 8: stamping a mismatched bannerUrl is a no-op.
  it('stampBannerFileId is a no-op when the bannerUrl does not match', async () => {
    const withBanner: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      visual: { ...DEFAULT_BOT_CONFIG.visual, bannerUrl: 'https://x/banner.jpg' },
    };
    const fetcher = vi.fn(async () => withBanner);
    const spy = spyHydrator();
    const store = fakeStore();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    await cache.get();
    const savedBefore = store.saved.length;
    cache.stampBannerFileId('https://other/banner.jpg', 'FILE_ID_123');
    await vi.runAllTimersAsync();
    expect(store.saved.length).toBe(savedBefore);
  });
});

describe('DEFAULT_BOT_CONFIG', () => {
  it('mirrors the rezeis-admin seed (4 visible buttons in known order)', () => {
    expect(DEFAULT_BOT_CONFIG.buttons.map((b) => b.id)).toEqual([
      'cabinet',
      'invite',
      'rules',
      'help',
    ]);
    for (const b of DEFAULT_BOT_CONFIG.buttons) {
      expect(b.visible).toBe(true);
    }
  });
});
