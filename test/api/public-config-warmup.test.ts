import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { warmPublicConfig } from '../../src/api/public-config-warmup.js';

/**
 * The operator config is read at start, before the first visitor asks: a
 * document served in the seconds after an update used to go out with no
 * config at all when the panel restarted alongside and Redis answered slowly.
 */

const OPTIONS = { waitMs: 3_000, retryMs: 2_000, giveUpMs: 120_000 } as const;

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('warmPublicConfig', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is "held" as soon as the first read answers', async () => {
    const read = vi.fn(async () => ({ branding: {} }));
    const log = logger();

    await expect(warmPublicConfig(read, { ...OPTIONS, logger: log })).resolves.toBe('held');
    expect(read).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ tookMs: expect.any(Number) }), 'public config read at start');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('tries again every retryMs, and is "held" when a later read answers inside the wait', async () => {
    const read = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('Command timed out'))
      .mockResolvedValue({ branding: {} });

    const outcome = warmPublicConfig(read, { ...OPTIONS, waitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toBe('held');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('lets the server listen after waitMs, and keeps trying in the background until a read lands', async () => {
    const read = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('admin down'));
    const log = logger();

    const outcome = warmPublicConfig(read, { ...OPTIONS, logger: log });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(outcome).resolves.toBe('pending');
    expect(log.warn).toHaveBeenCalledWith({ waitMs: 3_000 }, expect.stringContaining('keeps trying'));

    read.mockResolvedValue({ branding: {} });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(log.info).toHaveBeenCalledWith(expect.anything(), 'public config read at start');
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it('stops trying after giveUpMs', async () => {
    const read = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('admin down'));
    const log = logger();

    void warmPublicConfig(read, { ...OPTIONS, giveUpMs: 10_000, logger: log });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(read.mock.calls.length).toBeLessThanOrEqual(6);
    expect(log.warn).toHaveBeenCalledWith({ giveUpMs: 10_000 }, expect.stringContaining('still unreadable'));
  });

  it('counts a read that throws before it returns a promise as a failed attempt', async () => {
    let calls = 0;
    const read = (): Promise<unknown> => {
      calls += 1;
      if (calls === 1) throw new Error('not ready');
      return Promise.resolve({});
    };

    const outcome = warmPublicConfig(read, { ...OPTIONS, waitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toBe('held');
  });
});
