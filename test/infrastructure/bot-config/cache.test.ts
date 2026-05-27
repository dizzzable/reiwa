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
