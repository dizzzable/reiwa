/**
 * Banned-IP management specs (HIGH #11).
 *
 * Pins the self-expiring-ban contract that closes the "permanent ban with no
 * unban path" leak:
 *   - banIp writes with the default TTL.BANNED_IP (never permanent)
 *   - a custom ttl is honoured but still finite
 *   - clearBannedIp is the operator unban path and reports whether a ban existed
 *   - getBannedIp tolerates a corrupt stored value (stays banned, never throws)
 */
import { describe, expect, it } from 'vitest';

import {
  banIp,
  clearBannedIp,
  getBannedIp,
  isIpBanned,
} from '../../src/infrastructure/redis/ban-management.js';
import { TTL, bannedIpKey } from '../../src/infrastructure/redis/keys.js';

class InMemoryRedis {
  public readonly store = new Map<string, { value: string; ttl?: number }>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    let ttl: number | undefined;
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      ttl = args[1];
    }
    this.store.set(key, { value, ttl });
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

function build(): { redis: InMemoryRedis } {
  return { redis: new InMemoryRedis() };
}

describe('ban-management', () => {
  it('banIp writes a finite, self-expiring ban by default (never permanent)', async () => {
    const { redis } = build();
    await banIp(redis as never, '203.0.113.7', {
      reason: 'Coordinated brute-force attack',
      bannedAt: new Date().toISOString(),
      username: 'victim',
    });

    const stored = redis.store.get(bannedIpKey('203.0.113.7'));
    expect(stored).toBeDefined();
    expect(stored?.ttl).toBe(TTL.BANNED_IP);
    expect(stored?.ttl).toBeGreaterThan(0);
    expect(await isIpBanned(redis as never, '203.0.113.7')).toBe(true);
  });

  it('honours a custom ttl override but keeps it finite', async () => {
    const { redis } = build();
    await banIp(
      redis as never,
      '203.0.113.9',
      { reason: 'repeat offender', bannedAt: new Date().toISOString() },
      7 * 24 * 60 * 60,
    );
    expect(redis.store.get(bannedIpKey('203.0.113.9'))?.ttl).toBe(7 * 24 * 60 * 60);
  });

  it('clearBannedIp unbans and reports whether a ban existed', async () => {
    const { redis } = build();
    await banIp(redis as never, '198.51.100.4', {
      reason: 'x',
      bannedAt: new Date().toISOString(),
    });

    expect(await clearBannedIp(redis as never, '198.51.100.4')).toBe(true);
    expect(await isIpBanned(redis as never, '198.51.100.4')).toBe(false);
    // Second clear is a no-op and reports "nothing was banned".
    expect(await clearBannedIp(redis as never, '198.51.100.4')).toBe(false);
  });

  it('getBannedIp returns the record, or a safe fallback for a corrupt value', async () => {
    const { redis } = build();
    const record = {
      reason: 'Rate limit exceeded on /api/v1/auth/login',
      bannedAt: '2026-07-25T00:00:00.000Z',
    };
    await banIp(redis as never, '203.0.113.1', record);
    expect(await getBannedIp(redis as never, '203.0.113.1')).toMatchObject(record);

    // Corrupt stored JSON must NOT accidentally unban (stays banned, no throw).
    redis.store.set(bannedIpKey('203.0.113.2'), { value: 'not-json' });
    const fallback = await getBannedIp(redis as never, '203.0.113.2');
    expect(fallback).not.toBeNull();
    expect(fallback?.reason).toBe('unknown');

    expect(await getBannedIp(redis as never, '203.0.113.99')).toBeNull();
  });
});
