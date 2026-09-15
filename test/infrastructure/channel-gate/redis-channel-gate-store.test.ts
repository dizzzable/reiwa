/**
 * The channel gate's shared store: what reiwa-bot and reiwa-api keep in one
 * Redis — passes of «Перепроверять подписку» OFF and the operator-alert
 * throttle — and how it behaves when Redis is not there.
 *
 * Two `RedisChannelGateStore`s on one `FakeRedis` are two processes on one
 * server. The key shapes are asserted literally: the API process reads the keys
 * the bot writes, so a renamed key is a pass the other process cannot see.
 *
 * The store runs on the bot's one-update-at-a-time path, so a Redis that is not
 * there must cost nothing: no command is SENT while the client is not ready or
 * for ten seconds after one failed (each would wait out the two-second command
 * timeout). `FakeRedis.calls` is what was sent.
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryChannelGateStore } from '../../../src/infrastructure/channel-gate/channel-gate-store.js';
import { RedisChannelGateStore } from '../../../src/infrastructure/channel-gate/redis-channel-gate-store.js';
import { FakeRedis } from './fake-redis.js';

const CHAT = '-1001234567890';
const DAY_MS = 24 * 60 * 60 * 1000;

function logger() {
  const warn = vi.fn();
  return {
    warn,
    port: { fatal: vi.fn(), error: vi.fn(), warn, info: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
  };
}

function useClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RedisChannelGateStore — the keys both processes read', () => {
  it('records a pass as reiwa:channel-gate:v1:pass:<chatId>:<userId> with SET … PX', async () => {
    const redis = new FakeRedis();
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });

    await store.recordPass(CHAT, 4242, 365 * DAY_MS);

    expect(redis.calls).toEqual([
      { command: 'set', args: ['reiwa:channel-gate:v1:pass:-1001234567890:4242', '1', 'PX', 365 * DAY_MS] },
    ]);
    expect(await store.hasPass(CHAT, 4242)).toBe(true);
    expect(redis.calls.at(-1)).toEqual({ command: 'exists', args: ['reiwa:channel-gate:v1:pass:-1001234567890:4242'] });
  });

  it('spells a username in lower case, so retyping «Username канала» in another case keeps every pass', async () => {
    const redis = new FakeRedis();
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });

    await store.recordPass('@Rezeis_News', 4242, DAY_MS);

    expect(redis.keys()).toEqual(['reiwa:channel-gate:v1:pass:@rezeis_news:4242']);
    expect(await store.hasPass('@REZEIS_NEWS', 4242)).toBe(true);
  });

  it('claims an alert as reiwa:channel-gate:v1:alert:<sha256 of the cause> with SET … PX … NX', async () => {
    const redis = new FakeRedis();
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });
    const cause = 'refused:-1001234567890:Bad Request: member list is inaccessible';

    await store.claimAlert(cause, 60 * 60 * 1000);

    const digest = createHash('sha256').update(cause).digest('hex');
    expect(redis.calls).toEqual([
      { command: 'set', args: [`reiwa:channel-gate:v1:alert:${digest}`, '1', 'PX', 3_600_000, 'NX'] },
    ]);
  });

  it('never adds a listener to the client it is handed — the client is somebody else’s', () => {
    const redis = new FakeRedis();
    new RedisChannelGateStore({ redis: redis.asRedis() });
    expect(redis.listenersAdded).toBe(0);
  });
});

describe('RedisChannelGateStore — two processes, one Redis', () => {
  it('a pass one process records is a pass for the other, until one of them forgets it', async () => {
    const redis = new FakeRedis();
    const bot = new RedisChannelGateStore({ redis: redis.asRedis() });
    const api = new RedisChannelGateStore({ redis: redis.asRedis() });

    await bot.recordPass(CHAT, 4242, 365 * DAY_MS);
    expect(await api.hasPass(CHAT, 4242)).toBe(true);
    expect(await api.hasPass('@another_channel', 4242)).toBe(false);

    await api.forgetPass(CHAT, 4242);
    expect(await bot.hasPass(CHAT, 4242)).toBe(false);
  });

  it('only the first claim of a cause within the window wins, whichever process makes it', async () => {
    useClock();
    const redis = new FakeRedis();
    const bot = new RedisChannelGateStore({ redis: redis.asRedis() });
    const api = new RedisChannelGateStore({ redis: redis.asRedis() });

    expect(await bot.claimAlert('refused:x', 60 * 60 * 1000)).toBe(true);
    expect(await api.claimAlert('refused:x', 60 * 60 * 1000)).toBe(false);
    expect(await bot.claimAlert('refused:x', 60 * 60 * 1000)).toBe(false);
    expect(await api.claimAlert('refused:another cause', 60 * 60 * 1000)).toBe(true);

    advance(60 * 60 * 1000);
    expect(await api.claimAlert('refused:x', 60 * 60 * 1000)).toBe(true);
  });
});

describe('RedisChannelGateStore — a Redis that is not there costs no command', () => {
  it('sends nothing while the client is not ready, and answers from memory', async () => {
    for (const status of ['reconnecting', 'connecting', 'close', 'end']) {
      const redis = new FakeRedis();
      redis.status = status;
      const store = new RedisChannelGateStore({ redis: redis.asRedis() });

      await store.recordPass(CHAT, 4242, DAY_MS);
      expect(await store.hasPass(CHAT, 4242), status).toBe(true);
      expect(await store.claimAlert('refused:x', 60_000), status).toBe(true);
      expect(await store.claimAlert('refused:x', 60_000), status).toBe(false);
      await store.forgetPass(CHAT, 4242);
      expect(await store.hasPass(CHAT, 4242), status).toBe(false);
      expect(redis.calls, status).toEqual([]);
    }
  });

  it('asks a lazy client that was never used to connect, and answers from memory meanwhile', async () => {
    const redis = new FakeRedis();
    redis.status = 'wait';
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });

    expect(await store.hasPass(CHAT, 4242)).toBe(false);
    expect(redis.connectCalls).toBe(1);
    expect(redis.calls).toEqual([]);

    // Connected: the next read goes to Redis.
    await store.hasPass(CHAT, 4242);
    expect(redis.count('exists')).toBe(1);
  });

  it('after a failed command, sends nothing for 10 seconds — then tries again', async () => {
    useClock();
    const redis = new FakeRedis();
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });
    redis.failWith = new Error('Command timed out');

    expect(await store.hasPass(CHAT, 1)).toBe(false);
    expect(redis.calls).toHaveLength(1);

    redis.failWith = null;
    advance(9_999);
    await store.hasPass(CHAT, 2);
    await store.recordPass(CHAT, 3, DAY_MS);
    await store.claimAlert('refused:x', 60_000);
    await store.forgetPass(CHAT, 4);
    expect(redis.calls).toHaveLength(1);

    advance(1);
    await store.hasPass(CHAT, 5);
    expect(redis.calls).toHaveLength(2);
  });

  it('never rejects, and logs each failing operation once per 10 minutes', async () => {
    useClock();
    const redis = new FakeRedis();
    const log = logger();
    const store = new RedisChannelGateStore({ redis: redis.asRedis(), logger: log.port });
    const operations = (): unknown[] => log.warn.mock.calls.map((args) => (args[0] as { operation?: string }).operation);
    redis.failWith = new Error('Command timed out');

    await expect(store.hasPass(CHAT, 1)).resolves.toBe(false);
    advance(10_000);
    await expect(store.hasPass(CHAT, 1)).resolves.toBe(false);
    expect(operations()).toEqual(['hasPass']);

    advance(10 * 60 * 1000);
    await expect(store.hasPass(CHAT, 1)).resolves.toBe(false);
    expect(operations()).toEqual(['hasPass', 'hasPass']);
  });
});

describe('RedisChannelGateStore — reconciling an outage', () => {
  it('a pass recorded to memory during an outage still counts once Redis is back', async () => {
    const redis = new FakeRedis();
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });
    redis.status = 'reconnecting';
    await store.recordPass(CHAT, 4242, DAY_MS);

    redis.status = 'ready';
    expect(redis.keys()).toEqual([]);
    expect(await store.hasPass(CHAT, 4242)).toBe(true);
  });

  it('a pass that could not be deleted is treated as deleted for 10 minutes — the old Redis pass does not let the user back in', async () => {
    useClock();
    const redis = new FakeRedis();
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });
    await store.recordPass(CHAT, 4242, DAY_MS);

    redis.failWith = new Error('Command timed out');
    await store.forgetPass(CHAT, 4242);
    redis.failWith = null;
    advance(10_000);

    expect(redis.keys()).toEqual(['reiwa:channel-gate:v1:pass:-1001234567890:4242']);
    advance(10 * 60 * 1000 - 10_000 - 1);
    expect(await store.hasPass(CHAT, 4242)).toBe(false);
    advance(1);
    expect(await store.hasPass(CHAT, 4242)).toBe(true);
  });

  it('passing again lifts the tombstone', async () => {
    useClock();
    const redis = new FakeRedis();
    const store = new RedisChannelGateStore({ redis: redis.asRedis() });
    redis.status = 'reconnecting';
    await store.forgetPass(CHAT, 4242);
    redis.status = 'ready';

    await store.recordPass(CHAT, 4242, DAY_MS);
    expect(await store.hasPass(CHAT, 4242)).toBe(true);
  });
});

describe('MemoryChannelGateStore — a process without REDIS_URL', () => {
  it('expires a pass by the ttl it was recorded with, and claims an alert once per window', async () => {
    useClock();
    const store = new MemoryChannelGateStore();

    await store.recordPass(CHAT, 1, 60_000);
    expect(await store.hasPass(CHAT, 1)).toBe(true);
    advance(60_000);
    expect(await store.hasPass(CHAT, 1)).toBe(false);

    expect(await store.claimAlert('cause', 1_000)).toBe(true);
    expect(await store.claimAlert('cause', 1_000)).toBe(false);
    advance(1_000);
    expect(await store.claimAlert('cause', 1_000)).toBe(true);
  });

  it('spells a username in lower case too', async () => {
    const store = new MemoryChannelGateStore();
    await store.recordPass('@Rezeis_News', 1, 60_000);
    expect(await store.hasPass('@rezeis_news', 1)).toBe(true);
  });
});
