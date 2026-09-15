/**
 * The bot's end of the channel gate (`src/bot/lib/bot-channel-gate.ts`): the
 * gate's own Telegram client, the store beside it, and the chat the gate stands in.
 *
 * The client exists because `ctx.api` keeps grammY's 500-second timeout while
 * the bot handles updates one at a time. Its timeout is pinned as a literal,
 * and below the gate module's six-second deadline, so the client — which can
 * abort the request — gives up first.
 *
 * The Redis client is the gate's own: connected in the background as soon as it
 * is built — so the first update after a restart does not find it waiting, and
 * a bot whose Redis is down starts anyway — and logged by its owner, because the
 * store never adds a listener to a client it was handed.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_GATE_API_TIMEOUT_SECONDS,
  channelGateApiFor,
  channelGateDepsOf,
  createBotChannelGate,
  createChannelGateApi,
  isOwnPrivateChat,
} from '../../../src/bot/lib/bot-channel-gate.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { MemoryChannelGateStore } from '../../../src/infrastructure/channel-gate/channel-gate-store.js';
import { RedisChannelGateStore } from '../../../src/infrastructure/channel-gate/redis-channel-gate-store.js';

const TOKEN = '123456789:AAHfakeTokenForChannelGateSpecs_0123456';

function asCtx(ctx: object): BotContext {
  return ctx as unknown as BotContext;
}

function logger() {
  const warn = vi.fn();
  return {
    warn,
    port: { fatal: vi.fn(), error: vi.fn(), warn, info: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
  };
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** The store's client — held by the store and its owner only; the spec reaches in to close it. */
function clientOf(store: unknown): Redis {
  return (store as { redis: Redis }).redis;
}

describe('the gate’s Telegram client', () => {
  it('times out after 5 seconds — below the gate module’s 6-second deadline', () => {
    expect(CHANNEL_GATE_API_TIMEOUT_SECONDS).toBe(5);
  });

  it('gives up on a Bot API server that never answers, by its own timeout', async () => {
    const hanging = http.createServer(() => undefined);
    const port = await listen(hanging);
    try {
      const api = createChannelGateApi(TOKEN, `http://127.0.0.1:${port}`, 1);
      const started = Date.now();
      await expect(api.getChatMember('@rezeis_news', 4242)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      hanging.closeAllConnections();
      await close(hanging);
    }
  });

  it('is what bot surfaces ask through when it is wired, with the store beside it', () => {
    const gateApi = { getChatMember: async () => ({ status: 'member' }) };
    const store = new MemoryChannelGateStore();
    const ctx = asCtx({ api: { getChatMember: async () => ({ status: 'left' }) } });
    const deps = { adminClient: null, channelGate: { api: gateApi, store } } as unknown as PageDeps;

    expect(channelGateApiFor(ctx, deps)).toBe(gateApi);
    expect(channelGateDepsOf(deps)).toEqual({ adminClient: null, logger: undefined, store });
  });
});

describe('createBotChannelGate — what main.ts hands the pages', () => {
  it('the client it builds asks the configured Bot API root with the bot’s token, and gives up within 5 seconds', async () => {
    const paths: string[] = [];
    const hanging = http.createServer((req) => {
      paths.push(req.url ?? '');
    });
    const port = await listen(hanging);
    try {
      const gate = createBotChannelGate({ token: TOKEN, apiRoot: `http://127.0.0.1:${port}`, logger: logger().port });
      const started = Date.now();
      await expect(gate.api.getChatMember('@rezeis_news', 4242)).rejects.toThrow();
      const elapsed = Date.now() - started;
      expect(paths).toEqual([`/bot${TOKEN}/getChatMember`]);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      hanging.closeAllConnections();
      await close(hanging);
    }
  }, 15_000);

  it('without REDIS_URL: no store — the gate module keeps passes in process memory — and says so once', () => {
    const log = logger();
    const gate = createBotChannelGate({ token: TOKEN, redisUrl: undefined, logger: log.port });
    expect(gate.store).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain('REDIS_URL');
  });

  it('with REDIS_URL: a Redis store on a client that starts connecting at once, before the store is ever used', async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => sockets.push(socket));
    const port = await listen(server);
    const log = logger();
    const gate = createBotChannelGate({ token: TOKEN, redisUrl: `redis://127.0.0.1:${port}`, logger: log.port });
    try {
      expect(gate.store).toBeInstanceOf(RedisChannelGateStore);
      // No store call: waiting for the first one left every restart answering
      // its first updates from memory, and logging «Redis is wait».
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      expect(clientOf(gate.store).status).not.toBe('wait');
    } finally {
      clientOf(gate.store).disconnect();
      for (const socket of sockets) socket.destroy();
      await close(server);
    }
  });

  it('logs its client’s connection errors once per 10 minutes, not once per retry', async () => {
    // A port nothing listens on: every connection attempt fails.
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe);

    const log = logger();
    const gate = createBotChannelGate({ token: TOKEN, redisUrl: `redis://127.0.0.1:${port}`, logger: log.port });
    const client = clientOf(gate.store);
    let errors = 0;
    client.on('error', () => {
      errors += 1;
    });
    try {
      await gate.store?.hasPass('-1001234567890', 1);
      await vi.waitFor(() => expect(errors).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
      const connectionWarnings = log.warn.mock.calls.filter((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('Redis connection failed')),
      );
      expect(connectionWarnings).toHaveLength(1);
    } finally {
      client.disconnect();
    }
  });
});

describe('isOwnPrivateChat', () => {
  it('is the user’s private chat with the bot, and nothing else', () => {
    const from = { id: 4242 };
    expect(isOwnPrivateChat(asCtx({ from, chat: { id: 4242, type: 'private' } }))).toBe(true);
    expect(isOwnPrivateChat(asCtx({ from, chat: { id: -100123, type: 'supergroup' } }))).toBe(false);
    expect(isOwnPrivateChat(asCtx({ from, chat: { id: 4343, type: 'private' } }))).toBe(false);
    expect(isOwnPrivateChat(asCtx({ from }))).toBe(false);
    expect(isOwnPrivateChat(asCtx({ chat: { id: 4242, type: 'private' } }))).toBe(false);
  });
});
