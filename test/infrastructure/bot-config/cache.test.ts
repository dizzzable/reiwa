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
      visual: { ...DEFAULT_BOT_CONFIG.visual, welcomeMessage: 'persisted' },
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

  // Per-screen banner file_id is stamped onto the matching screen + re-persisted.
  it('stampScreenBannerFileId stamps the file_id onto the screen and re-persists', async () => {
    const withScreen: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      screens: [
        {
          id: 'sc1',
          shortId: 'sc_ref',
          name: 'Referral',
          textRu: '',
          textEn: '',
          parseMode: 'plain',
          mediaType: 'photo',
          mediaFileId: null,
          mediaUrl: '/uploads/bot-flow/ref.webp',
          isRoot: false,
          buttons: [],
        },
      ],
    };
    const fetcher = vi.fn(async () => withScreen);
    const spy = spyHydrator();
    const store = fakeStore();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });
    await cache.get();
    cache.stampScreenBannerFileId('sc_ref', '/uploads/bot-flow/ref.webp', 'SCREEN_FILE_ID');
    await vi.runAllTimersAsync();
    const last = store.saved[store.saved.length - 1];
    expect(last.screens?.[0]?.mediaFileId).toBe('SCREEN_FILE_ID');
    const out = await cache.get();
    expect(out.screens?.[0]?.mediaFileId).toBe('SCREEN_FILE_ID');
  });

  // No-op when the screen's mediaUrl no longer matches (banner was swapped).
  it('stampScreenBannerFileId is a no-op when the mediaUrl does not match', async () => {
    const withScreen: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      screens: [
        {
          id: 'sc1',
          shortId: 'sc_ref',
          name: 'Referral',
          textRu: '',
          textEn: '',
          parseMode: 'plain',
          mediaType: 'photo',
          mediaFileId: null,
          mediaUrl: '/uploads/bot-flow/new.webp',
          isRoot: false,
          buttons: [],
        },
      ],
    };
    const fetcher = vi.fn(async () => withScreen);
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
    cache.stampScreenBannerFileId('sc_ref', '/uploads/bot-flow/old.webp', 'SCREEN_FILE_ID');
    await vi.runAllTimersAsync();
    expect(store.saved.length).toBe(savedBefore);
  });
});

/**
 * An operator's save reaches the bot as `/invalidate` → `forceInvalidate()`. A
 * fetch already in flight at that moment may have read the config from BEFORE
 * the save. If it may still write when it lands, the bot runs on the old
 * config — with the old translator overrides and the old durable snapshot —
 * for another whole TTL, and the invalidate is already spent. Every upstream
 * here answers only when the test says so.
 */
describe('BotConfigCache across forceInvalidate()', () => {
  const SAVED: BotConfig & { translations: Record<string, string> } = {
    ...DEFAULT_BOT_CONFIG,
    translations: { 'en.menu.choose_action': 'Wording saved by the operator' },
  };

  function handAnswered() {
    const calls: Array<{ resolve: (value: BotConfig) => void; reject: (reason: unknown) => void }> = [];
    const fn = vi.fn(
      () =>
        new Promise<BotConfig>((resolve, reject) => {
          calls.push({ resolve, reject });
        }),
    );
    const call = (index: number) => {
      const pending = calls[index];
      if (pending === undefined) throw new Error(`upstream call #${index} was never made`);
      return pending;
    };
    return {
      fn,
      answer: (index: number, value: BotConfig): void => call(index).resolve(value),
      fail: (index: number, reason: unknown): void => call(index).reject(reason),
    };
  }

  function recordingStore(load: () => Promise<BotConfig | null> = async () => null) {
    const saved: BotConfig[] = [];
    const port: ConfigPersistencePort = {
      load,
      async save(config) {
        saved.push(config);
      },
    };
    return { port, saved };
  }

  it('a fetch begun before forceInvalidate() does not overwrite the config it fetched', async () => {
    const upstream = handAnswered();
    const spy = spyHydrator();
    const store = recordingStore();
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });

    const beforeSave = cache.get();
    const invalidated = cache.forceInvalidate('admin-pushed');
    upstream.answer(1, SAVED);
    expect(await invalidated).toBe(SAVED);

    upstream.answer(0, SAMPLE); // the old read lands last
    expect(await beforeSave).toBe(SAMPLE);

    expect(await cache.get()).toBe(SAVED);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    expect(spy.calls.at(-1)).toEqual(SAVED.translations);
    expect(store.saved.at(-1)).toBe(SAVED);
  });

  it('a fetch that lands after reset() with nobody else asking is not kept', async () => {
    const upstream = handAnswered();
    const spy = spyHydrator();
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
    });

    const beforeReset = cache.get();
    cache.reset();
    upstream.answer(0, SAMPLE);
    await beforeReset;

    const next = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, SAVED);
    expect(await next).toBe(SAVED);
  });

  it('a failed fetch begun before forceInvalidate() does not hydrate the translator over the saved config', async () => {
    const SNAPSHOT: BotConfig & { translations: Record<string, string> } = {
      ...DEFAULT_BOT_CONFIG,
      translations: { 'en.menu.choose_action': 'Wording from the last durable snapshot' },
    };
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    let answerLoad!: (config: BotConfig | null) => void;
    const store = recordingStore(() => {
      markLoadStarted();
      return new Promise((resolve) => {
        answerLoad = resolve;
      });
    });
    const upstream = handAnswered();
    const spy = spyHydrator();
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spy.hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: store.port,
    });

    const beforeSave = cache.get();
    const invalidated = cache.forceInvalidate('admin-pushed'); // still in flight
    // The old read fails while nothing is cached, so it reaches for the snapshot…
    upstream.fail(0, new Error('panel blinked'));
    await loadStarted;
    upstream.answer(1, SAVED);
    expect(await invalidated).toBe(SAVED);

    answerLoad(SNAPSHOT); // …and that snapshot read lands last
    await beforeSave;

    expect(spy.calls.at(-1)).toEqual(SAVED.translations);
  });

  it('of two invalidates in a row, only the newer hands back a config to push to Telegram', async () => {
    const SECOND_SAVE: BotConfig & { translations: Record<string, string> } = {
      ...DEFAULT_BOT_CONFIG,
      translations: { 'en.menu.choose_action': 'Wording from the second save' },
    };
    const upstream = handAnswered();
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spyHydrator().hydrator,
      fallback: DEFAULT_BOT_CONFIG,
    });

    const first = cache.forceInvalidate('admin-pushed');
    const second = cache.forceInvalidate('admin-pushed');
    upstream.answer(1, SECOND_SAVE);
    expect(await second).toBe(SECOND_SAVE);

    // The first save's read lands last. `handleInvalidate` pushes whatever
    // this resolves to, so anything but null would put the older profile on
    // Telegram after the newer one.
    upstream.answer(0, SAVED);
    expect(await first).toBeNull();
    expect(await cache.get()).toBe(SECOND_SAVE);
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
