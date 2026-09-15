/**
 * `TtlMap` — every channel-gate memory is one. Each entry expires by the window
 * it was set for, and memory stays bounded under a flood of distinct users.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TtlMap } from '../../../src/infrastructure/channel-gate/ttl-map.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('TtlMap', () => {
  it('expires each entry by its own deadline, not the longest one in the map', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const map = new TtlMap<string>({ maxEntries: 10 });

    map.set('strict-pass', true, 60_000);
    map.set('relaxed-memo', true, 10 * 60_000);
    vi.setSystemTime(Date.now() + 60_000);

    expect(map.has('strict-pass')).toBe(false);
    expect(map.has('relaxed-memo')).toBe(true);
  });

  it('a later set never shortens a deadline: a back-off that asks for less keeps the longer', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const map = new TtlMap<string, string>({ maxEntries: 10 });

    map.set('chat', 'flood', 60_000);
    map.set('chat', 'unreachable', 5_000);
    vi.setSystemTime(Date.now() + 59_999);

    expect(map.get('chat')).toBe('unreachable');
    vi.setSystemTime(Date.now() + 1);
    expect(map.has('chat')).toBe(false);
  });

  it('sweeps expired entries out on a later write, so dead entries do not accumulate', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const map = new TtlMap<number, number>({ maxEntries: 1_000, sweepEveryMs: 1_000 });
    for (let user = 0; user < 500; user += 1) map.set(user, user, 60_000);

    vi.setSystemTime(Date.now() + 60_000);
    map.set(9_999, 9_999, 60_000);

    expect(map.size).toBe(1);
  });

  it('drops the oldest entries past the ceiling instead of growing without bound', () => {
    const map = new TtlMap<number, number>({ maxEntries: 3 });
    for (let user = 1; user <= 5; user += 1) map.set(user, user, 60_000);

    expect(map.size).toBe(3);
    expect([1, 2, 3, 4, 5].map((user) => map.has(user))).toEqual([false, false, true, true, true]);
  });

  it('setting a key again moves it to the back of the eviction order and restarts its deadline', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const map = new TtlMap<number, number>({ maxEntries: 2 });
    map.set(1, 1, 60_000);
    map.set(2, 2, 60_000);
    vi.setSystemTime(Date.now() + 30_000);
    map.set(1, 1, 60_000);
    map.set(3, 3, 60_000);

    expect(map.has(2)).toBe(false);
    vi.setSystemTime(Date.now() + 45_000);
    expect(map.has(1)).toBe(true);
  });
});
