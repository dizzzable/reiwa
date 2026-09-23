/**
 * `configWithin` — the bot config within a budget, for a decision or a render
 * that must not hold the bot up.
 *
 * Updates are handled one at a time, and a config read past the cache's TTL
 * waits for the panel: the transport's ten seconds when it hangs. What cannot
 * be had in time falls back on the config the bot holds (`BotConfigCache.peek()`,
 * whatever its age): a stale config renders the operator's emoji, and none at
 * all renders none of them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configWithin } from '../../../src/bot/lib/config-within.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';

const HELD: BotConfig = { ...DEFAULT_BOT_CONFIG, screens: [] };
const FRESH: BotConfig = { ...DEFAULT_BOT_CONFIG, screens: [] };

const hangs = (): Promise<BotConfig> => new Promise<BotConfig>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe('configWithin', () => {
  it('gives the config when the read comes back in time', async () => {
    expect(await configWithin({ getConfig: async () => FRESH, peekConfig: () => HELD }, 250)).toBe(FRESH);
  });

  it('waits the whole budget for a slow read', async () => {
    vi.useFakeTimers();
    const slow = (): Promise<BotConfig> =>
      new Promise<BotConfig>((resolve) => {
        setTimeout(() => resolve(FRESH), 200);
      });
    const got = configWithin({ getConfig: slow, peekConfig: () => HELD }, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(await got).toBe(FRESH);
  });

  it('past the budget, gives the config the bot holds', async () => {
    vi.useFakeTimers();
    const got = configWithin({ getConfig: hangs, peekConfig: () => HELD }, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(await got).toBe(HELD);
  });

  it('past the budget with nothing held, gives null', async () => {
    vi.useFakeTimers();
    const got = configWithin({ getConfig: hangs, peekConfig: () => null }, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(await got).toBeNull();
    // …and so for a source with nothing to peek at.
    const bare = configWithin({ getConfig: hangs }, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(await bare).toBeNull();
  });

  it('takes a failed read for the config the bot holds, and never throws', async () => {
    const rejects = { getConfig: async (): Promise<BotConfig> => Promise.reject(new Error('panel down')), peekConfig: () => HELD };
    await expect(configWithin(rejects, 250)).resolves.toBe(HELD);
    // A getConfig that throws before it returns a promise, too — with nothing held.
    const throws = {
      getConfig: (): Promise<BotConfig> => {
        throw new Error('boom');
      },
    };
    await expect(configWithin(throws, 250)).resolves.toBeNull();
  });

  it('asks the source every time: a read after a failed one goes out', async () => {
    let fail = true;
    const getConfig = vi.fn(async (): Promise<BotConfig> => {
      if (fail) throw new Error('panel blinked');
      return FRESH;
    });
    expect(await configWithin({ getConfig }, 250)).toBeNull();
    fail = false;
    expect(await configWithin({ getConfig }, 250)).toBe(FRESH);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('once the panel is back, the next ask gets the fresh config — not a read begun while it hung', async () => {
    vi.useFakeTimers();
    let panelBack = false;
    const getConfig = vi.fn((): Promise<BotConfig> => (panelBack ? Promise.resolve(FRESH) : hangs()));
    const first = configWithin({ getConfig, peekConfig: () => HELD }, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toBe(HELD);

    panelBack = true;
    expect(await configWithin({ getConfig, peekConfig: () => HELD }, 250)).toBe(FRESH);
  });
});
