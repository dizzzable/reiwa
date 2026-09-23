/**
 * The warm-up tick keeps an idle bot's config entry fresh.
 *
 * It ran every five minutes — the cache's TTL — through `get()`, which skips an
 * entry still fresh. A refresh lands a moment after its tick, so the next tick
 * found the entry just short of the TTL and skipped it: an idle bot's entry was
 * stale about half the time, and the next user action paid the panel round trip
 * (with a slow panel, the budget and a fallback). Every tick now reads the
 * panel, and ticks come before the TTL is out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_WARMUP_MS, startConfigWarmup } from '../../../src/bot/lib/config-warmup.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';

const TTL_MS = 5 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

/** A panel that answers the boot read at once, and every later read in 2 s. */
function panel() {
  let calls = 0;
  const fetcher = vi.fn((): Promise<BotConfig> => {
    calls += 1;
    if (calls === 1) return Promise.resolve(DEFAULT_BOT_CONFIG);
    return new Promise<BotConfig>((resolve) => {
      setTimeout(() => resolve(DEFAULT_BOT_CONFIG), 2_000);
    });
  });
  return fetcher;
}

/** A user action: served at once from the entry, or left waiting on the panel. */
async function servedAtOnce(cache: BotConfigCache): Promise<boolean> {
  let served = false;
  void cache.get().then(() => {
    served = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return served;
}

describe('startConfigWarmup', () => {
  it('ticks before the cache’s TTL is out', () => {
    expect(CONFIG_WARMUP_MS).toBeLessThan(TTL_MS);
  });

  it('keeps an idle bot’s entry fresh: no user action waits for the panel', async () => {
    vi.useFakeTimers();
    const fetcher = panel();
    const cache = new BotConfigCache({ fetcher, hydrator: { setOverrides: () => undefined }, fallback: DEFAULT_BOT_CONFIG, ttlMs: TTL_MS });
    await cache.get(); // the boot read
    const timer = startConfigWarmup(cache);
    try {
      const stale: number[] = [];
      for (let at = 10_000; at <= 15 * 60 * 1000; at += 10_000) {
        await vi.advanceTimersByTimeAsync(10_000);
        if (!(await servedAtOnce(cache))) stale.push(at / 1000);
      }
      expect(stale).toEqual([]);
    } finally {
      clearInterval(timer);
    }
  });

  it('reads the panel on every tick, whether or not the entry is still fresh', async () => {
    vi.useFakeTimers();
    const fetcher = panel();
    const cache = new BotConfigCache({ fetcher, hydrator: { setOverrides: () => undefined }, fallback: DEFAULT_BOT_CONFIG, ttlMs: TTL_MS });
    await cache.get();
    const timer = startConfigWarmup(cache);
    try {
      await vi.advanceTimersByTimeAsync(3 * CONFIG_WARMUP_MS + 5_000);
      expect(fetcher).toHaveBeenCalledTimes(1 + 3);
    } finally {
      clearInterval(timer);
    }
  });
});
