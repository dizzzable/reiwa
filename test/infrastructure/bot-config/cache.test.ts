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

  // `handleInvalidate` pushes what this hands back to Telegram — the commands,
  // the bot profile, the menu button. A read that failed handed back the
  // config the bot held, or DEFAULT on a cold start with no saved copy.
  it('hands back nothing to push when its read fails — not the held entry, not DEFAULT', async () => {
    const upstream = handAnswered();
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spyHydrator().hydrator,
      fallback: DEFAULT_BOT_CONFIG,
    });
    const cold = cache.forceInvalidate('admin-pushed');
    upstream.fail(0, new Error('connect ECONNREFUSED'));
    expect(await cold).toBeNull();

    const warm = cache.forceInvalidate('admin-pushed');
    upstream.answer(1, SAMPLE);
    expect(await warm).toBe(SAMPLE);
    const failed = cache.forceInvalidate('admin-pushed');
    upstream.fail(2, new Error('connect ECONNREFUSED'));
    expect(await failed).toBeNull();
    expect(cache.peek()).toBe(SAMPLE);
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

/** An upstream whose every call waits until the test answers it. */
function handAnsweredUpstream() {
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

const SAVED_BY_OPERATOR: BotConfig & { translations: Record<string, string> } = {
  ...DEFAULT_BOT_CONFIG,
  translations: { 'en.menu.choose_action': 'Wording saved by the operator' },
};

/**
 * `peek()` — the config the cache holds, for a caller that must not wait for
 * the panel (`bot/lib/config-within.ts`): a stale config renders the operator's
 * emoji, nothing renders none of them.
 */
describe('BotConfigCache.peek()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds nothing before the first successful fetch', async () => {
    const cache = new BotConfigCache({
      fetcher: async () => {
        throw new Error('panel down');
      },
      hydrator: spyHydrator().hydrator,
      fallback: DEFAULT_BOT_CONFIG,
    });
    expect(cache.peek()).toBeNull();
    expect(await cache.get()).toBe(DEFAULT_BOT_CONFIG);
    expect(cache.peek()).toBeNull();
  });

  it('gives the entry whatever its age, and never asks the panel', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => SAMPLE);
    const cache = new BotConfigCache({ fetcher, hydrator: spyHydrator().hydrator, fallback: DEFAULT_BOT_CONFIG, ttlMs: 10_000 });
    await cache.get();
    vi.advanceTimersByTime(60_000);
    expect(cache.peek()).toBe(SAMPLE);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the entry while forceInvalidate() reads the operator’s save, then holds the save', async () => {
    const upstream = handAnsweredUpstream();
    const cache = new BotConfigCache({ fetcher: upstream.fn, hydrator: spyHydrator().hydrator, fallback: DEFAULT_BOT_CONFIG });
    const first = cache.get();
    upstream.answer(0, SAMPLE);
    await first;

    const invalidated = cache.forceInvalidate('admin-pushed');
    expect(cache.peek()).toBe(SAMPLE);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, SAVED_BY_OPERATOR);
    expect(await invalidated).toBe(SAVED_BY_OPERATOR);
    expect(cache.peek()).toBe(SAVED_BY_OPERATOR);
  });

  // A boot while the panel hangs: the read times out and the bot runs on the
  // saved copy (Redis). `peek()` has to hold that copy — the budgeted replies
  // fall back on it — and keep it stale, so the next `get()` asks the panel.
  it('a cold start on the saved copy: peek() holds it, stale — once the hold-off is over, get() asks the panel', async () => {
    vi.useFakeTimers();
    const SAVED_COPY: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      customEmojis: { phone: { id: '5368324170671202286', fallback: '📱' } },
    };
    const upstream = handAnsweredUpstream();
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spyHydrator().hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: { load: async () => SAVED_COPY, save: async () => undefined },
    });
    const boot = cache.get();
    upstream.fail(0, new Error('headers timeout'));
    expect(await boot).toBe(SAVED_COPY);
    expect(cache.peek()).toBe(SAVED_COPY);
    // Within the hold-off, the copy is served without asking the panel.
    expect(await cache.get()).toBe(SAVED_COPY);
    expect(upstream.fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    const next = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, SAMPLE);
    expect(await next).toBe(SAMPLE);
    expect(cache.peek()).toBe(SAMPLE);
  });

  it('a saved copy loaded by a fetch an invalidate overtook is not kept', async () => {
    const SAVED_COPY: BotConfig = { ...DEFAULT_BOT_CONFIG, screens: [] };
    let answerLoad!: (config: BotConfig | null) => void;
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    const upstream = handAnsweredUpstream();
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spyHydrator().hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      persistence: {
        load: () => {
          markLoadStarted();
          return new Promise<BotConfig | null>((resolve) => {
            answerLoad = resolve;
          });
        },
        save: async () => undefined,
      },
    });
    const boot = cache.get();
    upstream.fail(0, new Error('headers timeout'));
    await loadStarted;
    const invalidated = cache.forceInvalidate('admin-pushed');
    answerLoad(SAVED_COPY); // the saved copy lands after the operator's save was asked for
    expect(await boot).toBe(SAVED_COPY);
    expect(cache.peek()).toBeNull();

    upstream.answer(1, SAVED_BY_OPERATOR);
    expect(await invalidated).toBe(SAVED_BY_OPERATOR);
    expect(cache.peek()).toBe(SAVED_BY_OPERATOR);
  });

  it('after forceInvalidate(), a get() never serves the entry it kept: the save is read first', async () => {
    const upstream = handAnsweredUpstream();
    const cache = new BotConfigCache({ fetcher: upstream.fn, hydrator: spyHydrator().hydrator, fallback: DEFAULT_BOT_CONFIG });
    const first = cache.get();
    upstream.answer(0, SAMPLE);
    await first;

    void cache.forceInvalidate('admin-pushed');
    const next = cache.get();
    upstream.answer(1, SAVED_BY_OPERATOR);
    expect(await next).toBe(SAVED_BY_OPERATOR);
  });
});

/**
 * One fetch for concurrent reads of a stale entry — every page's read and the
 * welcome screen's two used to send one each. An invalidate still wins: a read
 * that comes after `reset()` or `forceInvalidate()` may not join a fetch begun
 * before it, which may have read the config from before the operator's save.
 */
describe('BotConfigCache — one fetch at a time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function cacheOn(upstream: ReturnType<typeof handAnsweredUpstream>) {
    return new BotConfigCache({ fetcher: upstream.fn, hydrator: spyHydrator().hydrator, fallback: DEFAULT_BOT_CONFIG });
  }

  it('concurrent reads join one fetch', async () => {
    const upstream = handAnsweredUpstream();
    const cache = cacheOn(upstream);
    const a = cache.get();
    const b = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(1);
    upstream.answer(0, SAMPLE);
    expect(await a).toBe(SAMPLE);
    expect(await b).toBe(SAMPLE);
  });

  it('a read after forceInvalidate() does not join a fetch begun before it', async () => {
    const upstream = handAnsweredUpstream();
    const cache = cacheOn(upstream);
    const before = cache.get();
    const invalidated = cache.forceInvalidate('admin-pushed');
    const after = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(2);

    upstream.answer(0, SAMPLE); // the pre-save read lands first
    expect(await before).toBe(SAMPLE);
    upstream.answer(1, SAVED_BY_OPERATOR);
    expect(await after).toBe(SAVED_BY_OPERATOR);
    expect(await invalidated).toBe(SAVED_BY_OPERATOR);
  });

  it('a read after reset() does not join a fetch begun before it', async () => {
    const upstream = handAnsweredUpstream();
    const cache = cacheOn(upstream);
    const before = cache.get();
    cache.reset();
    const after = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(2);

    upstream.answer(1, SAVED_BY_OPERATOR);
    expect(await after).toBe(SAVED_BY_OPERATOR);
    upstream.answer(0, SAMPLE); // the pre-reset read lands last, and is not kept
    expect(await before).toBe(SAMPLE);
    expect(await cache.get()).toBe(SAVED_BY_OPERATOR);
  });

  it('the older fetch landing does not free the newer fetch’s slot', async () => {
    const upstream = handAnsweredUpstream();
    const cache = cacheOn(upstream);
    const before = cache.get();
    void cache.forceInvalidate('admin-pushed');
    upstream.answer(0, SAMPLE);
    await before;

    const joiner = cache.get(); // the save is still being read: join it
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, SAVED_BY_OPERATOR);
    expect(await joiner).toBe(SAVED_BY_OPERATOR);
  });

  it('a read after a failed fetch goes out again, once the hold-off is over', async () => {
    vi.useFakeTimers();
    const upstream = handAnsweredUpstream();
    const cache = cacheOn(upstream);
    const failed = cache.get();
    upstream.fail(0, new Error('panel blinked'));
    expect(await failed).toBe(DEFAULT_BOT_CONFIG);

    vi.advanceTimersByTime(10_000);
    const again = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, SAMPLE);
    expect(await again).toBe(SAMPLE);
  });

  // During an outage the log gets one line per failed fetch — not one per read:
  // every read that came while it was in flight joined it.
  it('warns once per failed fetch, however many reads joined it', async () => {
    vi.useFakeTimers();
    const upstream = handAnsweredUpstream();
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
    const cache = new BotConfigCache({
      fetcher: upstream.fn,
      hydrator: spyHydrator().hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      logger: logger as unknown as ConstructorParameters<typeof BotConfigCache>[0]['logger'],
    });
    const reads = [cache.get(), cache.get(), cache.refresh()];
    upstream.fail(0, new Error('panel down'));
    await Promise.all(reads);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe('BotConfigCache: refresh failed; serving stale or fallback');

    vi.advanceTimersByTime(10_000); // past the hold-off: the next read fetches, and fails
    const again = cache.get();
    upstream.fail(1, new Error('panel down'));
    await again;
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('refresh() reads the panel though the entry is fresh; reads meanwhile are served from the entry', async () => {
    const upstream = handAnsweredUpstream();
    const cache = cacheOn(upstream);
    const first = cache.get();
    upstream.answer(0, SAMPLE);
    await first;

    const refreshed = cache.refresh();
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    // Fresh: a read is served at once, from the entry, while the refresh runs.
    expect(await cache.get()).toBe(SAMPLE);
    upstream.answer(1, SAVED_BY_OPERATOR);
    expect(await refreshed).toBe(SAVED_BY_OPERATOR);
    expect(cache.peek()).toBe(SAVED_BY_OPERATOR);
  });
});

/**
 * After a failed fetch, reads hold off for ten seconds: they serve what a
 * failed read serves — the held entry, the saved copy, or the fallback —
 * without a fetch. A panel that refuses connections fails a fetch at once, so
 * without it every update paid a network attempt against a panel that was
 * down, and wrote a warning. An invalidate ends the hold-off: the operator's
 * save is read at once.
 */
describe('BotConfigCache — a hold-off after a failed fetch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const TTL_MS = 60_000;

  function logger() {
    const warn = vi.fn();
    const port = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
    return { warn, port: port as unknown as ConstructorParameters<typeof BotConfigCache>[0]['logger'] };
  }

  /** A cache whose entry was read at boot and has since gone stale; the panel now refuses. */
  async function staleCacheOnRefusingPanel() {
    let refusing = false;
    const fetcher = vi.fn(async () => {
      if (refusing) throw new Error('connect ECONNREFUSED');
      return SAMPLE;
    });
    const log = logger();
    const cache = new BotConfigCache({
      fetcher,
      hydrator: spyHydrator().hydrator,
      fallback: DEFAULT_BOT_CONFIG,
      ttlMs: TTL_MS,
      logger: log.port,
    });
    await cache.get();
    vi.advanceTimersByTime(TTL_MS);
    refusing = true;
    return {
      cache,
      fetcher,
      warn: log.warn,
      recover: () => {
        refusing = false;
      },
    };
  }

  it('a refused-connection panel: N updates within 10 s give 1 fetch and 1 warning', async () => {
    vi.useFakeTimers();
    const { cache, fetcher, warn } = await staleCacheOnRefusingPanel();
    const served: BotConfig[] = [];
    for (let update = 0; update < 20; update += 1) {
      served.push(await cache.get());
      vi.advanceTimersByTime(450); // 20 updates over 9 s
    }
    expect(fetcher).toHaveBeenCalledTimes(1 + 1); // the boot read, and one that failed
    expect(warn).toHaveBeenCalledTimes(1);
    expect(served.every((config) => config === SAMPLE)).toBe(true);
  });

  it('holds off on a cold start too: the fallback, without a fetch per update', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const log = logger();
    const cache = new BotConfigCache({ fetcher, hydrator: spyHydrator().hydrator, fallback: DEFAULT_BOT_CONFIG, logger: log.port });
    for (let update = 0; update < 10; update += 1) {
      expect(await cache.get()).toBe(DEFAULT_BOT_CONFIG);
      vi.advanceTimersByTime(900);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('forceInvalidate() during the hold-off reads the save at once', async () => {
    vi.useFakeTimers();
    const { cache, fetcher, recover } = await staleCacheOnRefusingPanel();
    await cache.get(); // fails: the hold-off begins
    expect(fetcher).toHaveBeenCalledTimes(2);

    recover();
    expect(await cache.forceInvalidate('admin-pushed')).toBe(SAMPLE);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reset() ends the hold-off too', async () => {
    vi.useFakeTimers();
    const { cache, fetcher } = await staleCacheOnRefusingPanel();
    await cache.get(); // fails: the hold-off begins
    cache.reset();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('after the window ends, the next read fetches', async () => {
    vi.useFakeTimers();
    const { cache, fetcher, recover } = await staleCacheOnRefusingPanel();
    await cache.get(); // fails: the hold-off begins
    vi.advanceTimersByTime(9_999);
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);

    recover();
    vi.advanceTimersByTime(1);
    expect(await cache.get()).toBe(SAMPLE);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('a pre-save fetch failing late does not replace the hold-off of the save’s failed read', async () => {
    vi.useFakeTimers();
    const upstream = handAnsweredUpstream();
    const cache = new BotConfigCache({ fetcher: upstream.fn, hydrator: spyHydrator().hydrator, fallback: DEFAULT_BOT_CONFIG });
    const before = cache.get();
    const invalidated = cache.forceInvalidate('admin-pushed');
    upstream.fail(1, new Error('panel down')); // the save's read fails: its hold-off begins
    await invalidated;
    upstream.fail(0, new Error('panel down')); // the pre-save read fails after it
    await before;

    void cache.get(); // within the save's hold-off
    expect(upstream.fn).toHaveBeenCalledTimes(2);
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
