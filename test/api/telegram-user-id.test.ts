/**
 * The account → Telegram user id memory behind the Mini App channel gate
 * (`src/api/lib/telegram-user-id.ts`): what it accepts as an id, how long it
 * trusts an answer, what it refuses to remember, and that it cannot grow with
 * everyone who ever opened the Mini App.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTelegramUserIdCache,
  parseTelegramUserId,
} from '../../src/api/lib/telegram-user-id.js';

describe('parseTelegramUserId', () => {
  it('takes the positive integer ids Telegram issues, as rezeis and the legacy session store them', () => {
    expect(parseTelegramUserId('4242')).toBe(4242);
    expect(parseTelegramUserId('7000000001')).toBe(7000000001);
    expect(parseTelegramUserId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseTelegramUserId(4242)).toBe(4242);
  });

  it('refuses what would name the wrong person or no person', () => {
    for (const value of [
      // Rounds to …992 as a number: a DIFFERENT id.
      '9007199254740993',
      9007199254740992,
      '99999999999999999',
      // A chat, not a user.
      '-1001234567890',
      -4242,
      '0',
      0,
      '007',
      ' 4242',
      '4242.0',
      4242.5,
      '12abc',
      '',
      null,
      undefined,
      {},
    ]) {
      expect(parseTelegramUserId(value), String(value)).toBeNull();
    }
  });
});

describe('createTelegramUserIdCache', () => {
  function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let current = start;
    return { now: () => current, advance: (ms) => void (current += ms) };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  // The production defaults, written as literals: a spec that imported the
  // constants would agree with any value they were changed to.
  it('by default trusts an answer for exactly 5 minutes', async () => {
    const time = clock();
    const lookup = vi.fn(async () => '4242');
    const cache = createTelegramUserIdCache({ lookup, now: time.now });

    await cache.resolve('acc-1');
    time.advance(299_999);
    await cache.resolve('acc-1');
    expect(lookup).toHaveBeenCalledTimes(1);
    time.advance(1);
    await cache.resolve('acc-1');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('by default remembers at most 10 000 accounts', async () => {
    const lookup = vi.fn(async () => '4242');
    const cache = createTelegramUserIdCache({ lookup });

    for (let i = 0; i < 10_001; i += 1) await cache.resolve(`acc-${i}`);
    expect(cache.size).toBe(10_000);
    // The oldest went; the newest stayed.
    await cache.resolve('acc-10000');
    expect(lookup).toHaveBeenCalledTimes(10_001);
    await cache.resolve('acc-0');
    expect(lookup).toHaveBeenCalledTimes(10_002);
  });

  it('ages entries by the clock of the moment it is asked, not the one it was built with', async () => {
    const lookup = vi.fn(async () => '4242');
    // Built before the clock is swapped, the way a router is built before a spec fakes time.
    const cache = createTelegramUserIdCache({ lookup });
    vi.useFakeTimers({ toFake: ['Date'] });

    await cache.resolve('acc-1');
    vi.setSystemTime(Date.now() + 300_000);
    await cache.resolve('acc-1');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('asks the panel once per account per window, and again once the window has passed', async () => {
    const time = clock();
    const lookup = vi.fn(async () => '4242');
    const cache = createTelegramUserIdCache({ lookup, ttlMs: 1_000, now: time.now });

    expect(await cache.resolve('acc-1')).toBe(4242);
    time.advance(999);
    expect(await cache.resolve('acc-1')).toBe(4242);
    expect(lookup).toHaveBeenCalledTimes(1);

    time.advance(1);
    expect(await cache.resolve('acc-1')).toBe(4242);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('remembers "no Telegram id" like any other answer', async () => {
    const lookup = vi.fn(async () => null);
    const cache = createTelegramUserIdCache({ lookup });

    expect(await cache.resolve('web-only')).toBeNull();
    expect(await cache.resolve('web-only')).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('shares one read between callers that arrive while it is in flight', async () => {
    const pending: Array<(value: unknown) => void> = [];
    const lookup = vi.fn(() => new Promise<unknown>((resolve) => pending.push(resolve)));
    const cache = createTelegramUserIdCache({ lookup });

    const first = cache.resolve('acc-1');
    const second = cache.resolve('acc-1');
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
    // Answer every read that was started, so a second one fails the count
    // below instead of hanging the case.
    for (const answer of pending) answer('4242');
    expect(await Promise.all([first, second])).toEqual([4242, 4242]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed read at once, so the next request asks again', async () => {
    const lookup = vi
      .fn<(userId: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('Upstream 502'))
      .mockResolvedValueOnce('4242');
    const cache = createTelegramUserIdCache({ lookup });

    await expect(cache.resolve('acc-1')).rejects.toThrow('Upstream 502');
    await Promise.resolve();
    expect(cache.size).toBe(0);
    expect(await cache.resolve('acc-1')).toBe(4242);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('turns a lookup that throws synchronously into a rejection, not an escape', async () => {
    const cache = createTelegramUserIdCache({
      lookup: () => {
        throw new Error('AdminClient not configured');
      },
    });

    await expect(cache.resolve('acc-1')).rejects.toThrow('AdminClient not configured');
  });

  it('is bounded: past its ceiling the oldest account is dropped, the newest kept', async () => {
    const lookup = vi.fn(async (userId: string) => userId.replace('acc-', ''));
    const cache = createTelegramUserIdCache({ lookup, maxEntries: 3 });

    for (const id of ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5']) await cache.resolve(id);
    expect(cache.size).toBe(3);

    // acc-5 is still remembered…
    await cache.resolve('acc-5');
    expect(lookup).toHaveBeenCalledTimes(5);
    // …acc-1 was the oldest and is asked for again.
    expect(await cache.resolve('acc-1')).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(6);
    expect(cache.size).toBe(3);
  });

  it('drops expired accounts on the next write even below its ceiling', async () => {
    const time = clock();
    const cache = createTelegramUserIdCache({ lookup: async () => '4242', ttlMs: 1_000, now: time.now });

    await cache.resolve('acc-1');
    await cache.resolve('acc-2');
    time.advance(1_000);
    await cache.resolve('acc-3');
    // Only the live one is left: the map is as large as the last window's users.
    expect(cache.size).toBe(1);
  });

  it('a refreshed account moves to the back of the line, so eviction takes the truly oldest', async () => {
    const time = clock();
    const lookup = vi.fn(async () => '4242');
    const cache = createTelegramUserIdCache({ lookup, ttlMs: 1_000, maxEntries: 2, now: time.now });

    await cache.resolve('acc-1');
    time.advance(600);
    await cache.resolve('acc-2');
    time.advance(600);
    // acc-1 expired and is read again: it is now the NEWEST entry.
    await cache.resolve('acc-1');
    time.advance(100);
    await cache.resolve('acc-3');
    expect(cache.size).toBe(2);

    const calls = lookup.mock.calls.length;
    await cache.resolve('acc-1');
    expect(lookup).toHaveBeenCalledTimes(calls);
  });
});
