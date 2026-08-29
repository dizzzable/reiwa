import { describe, expect, it } from 'vitest';

import { sweepExpired } from '../../../src/bot/lib/bounded-map.js';

/**
 * The maps the bot keeps per user expired an entry only when that SAME key was
 * read again — so anybody who passed the channel gate once and never came back
 * left a row for the lifetime of the process. The maps grew with everyone who
 * had ever touched the bot rather than with who was using it, and a deploy
 * resetting them is exactly why it went unnoticed.
 */
describe('sweepExpired', () => {
  it('does nothing while the map is under the threshold', () => {
    // The ordinary path must stay a single `Map.set`; walking a small map on
    // every write would trade a slow leak for a constant cost.
    const map = new Map<number, number>([[1, 0]]);

    sweepExpired(map, 10, () => true);

    expect(map.size).toBe(1);
  });

  it('drops the expired entries once the map is over it', () => {
    const map = new Map<number, number>();
    for (let i = 0; i < 12; i += 1) map.set(i, i);

    sweepExpired(map, 10, (value) => value < 8);

    expect(map.size).toBe(4);
    expect([...map.keys()]).toEqual([8, 9, 10, 11]);
  });

  it('keeps every live entry, even when that leaves the map over the threshold', () => {
    // A genuine burst of concurrent users is load, not a leak. Dropping live
    // rows here would silently turn a rate limiter into a no-op for whoever got
    // evicted — the one direction that must not happen quietly.
    const map = new Map<number, number>();
    for (let i = 0; i < 30; i += 1) map.set(i, i);

    sweepExpired(map, 10, () => false);

    expect(map.size).toBe(30);
  });

  it('uses the caller’s own staleness rule, so a swept map cannot disagree with an unswept one', () => {
    const map = new Map<number, { expiresAt: number }>();
    for (let i = 0; i < 12; i += 1) map.set(i, { expiresAt: i < 6 ? 1 : Number.MAX_SAFE_INTEGER });

    sweepExpired(map, 10, (v) => v.expiresAt <= Date.now());

    expect(map.size).toBe(6);
  });
});
