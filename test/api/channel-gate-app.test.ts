/**
 * The Mini App channel gate as the cabinet actually serves it: mounted by the
 * real `createApp`, behind the real WebSession middleware and CSRF check, asking
 * a local server that plays the Bot API through grammY's real client — built by
 * the route from `BOT_TOKEN` and `TELEGRAM_BOT_API_ROOT`, the way production
 * builds it — with the gate's shared store on the app's own Redis client.
 *
 * The app side is driven without a socket (`socketless-request.ts` says why);
 * the Bot API side cannot be, since the client under test is the one that opens
 * the connection.
 *
 * What only this file can show:
 *  - the routes are reachable at `/api/v1/channel-gate` in the assembled app;
 *  - the POST the SPA makes passes the app-wide CSRF check exactly when it
 *    carries the cabinet's own `Origin` — which is what the SPA has to send;
 *  - the API talks to the operator's Local Bot API Server when one is set, with
 *    the bot's token, and gives up on a Telegram that stops answering after the
 *    production timeout;
 *  - the assembled app hands the gate the store the bot writes to.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createChatMemberApi } from '../../src/api/routes/channel-gate.js';
import { resetChannelGateMemory, settleChannelGateBackground } from '../../src/bot/lib/channel-gate.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { FakeRedis } from '../infrastructure/channel-gate/fake-redis.js';
import { sendSocketless } from './socketless-request.js';

/** Shaped like a real token; only ever sent to 127.0.0.1. */
const TOKEN = '123456789:AAHfakeTokenForChannelGateApiSpecs_012';
const JOIN_URL = 'https://t.me/rezeis_news';

interface BotApiCall {
  readonly path: string;
  readonly payload: Record<string, unknown>;
}

interface LocalBotApi {
  readonly apiRoot: string;
  readonly calls: BotApiCall[];
  /** Settles when the first request has been read to the end. */
  readonly firstCall: Promise<void>;
  readonly close: () => Promise<void>;
}

/** A local "Bot API". `answer` of `null` never responds. */
async function localBotApi(answer: { status: string } | null): Promise<LocalBotApi> {
  const calls: BotApiCall[] = [];
  let arrived: () => void = () => undefined;
  const firstCall = new Promise<void>((resolve) => (arrived = resolve));
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ path: req.url ?? '', payload: (body.length > 0 ? JSON.parse(body) : {}) as Record<string, unknown> });
      arrived();
      if (answer === null) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { ...answer, user: { id: 4242, is_bot: false, first_name: 'Ann' } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    firstCall,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const servers: LocalBotApi[] = [];

async function startBotApi(answer: { status: string } | null): Promise<LocalBotApi> {
  const api = await localBotApi(answer);
  servers.push(api);
  return api;
}

/**
 * The assembled app, with one live WebSession (`reiwa_web_session=ws-1`) for an
 * account whose Telegram id is 4242, and `redis` behind the session store.
 */
function buildApp(apiRoot: string, options: { redis?: FakeRedis; channelRecheck?: boolean } = {}) {
  const redis = options.redis ?? new FakeRedis();
  const adminClient = {
    system: {
      // The exact keys rezeis sends: the gate on, only «Ссылка на канал» filled.
      getPlatformPolicy: vi.fn(async () => ({
        accessMode: 'PUBLIC',
        rulesRequired: false,
        rulesLink: '',
        channelRequired: true,
        channelLink: JOIN_URL,
        channelId: null,
        channelUsername: null,
        channelRecheck: options.channelRecheck ?? true,
        requireTelegramWebCredentials: false,
        defaultCurrency: 'RUB',
        renewalAddOns: false,
      })),
      reportError: vi.fn(async () => ({})),
    },
    user: { getSession: vi.fn(async () => ({ id: 'acc-1', telegramId: '4242' })) },
  };
  const webSessionStore = {
    getRedis: () => redis.asRedis(),
    get: async (id: string) =>
      id === 'ws-1' ? { userId: 'acc-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 } : null,
    touch: async () => undefined,
  };
  return createApp({
    adminClient: adminClient as never,
    sessionStore: null,
    webSessionStore: webSessionStore as never,
    config: {
      NODE_ENV: 'test',
      BOT_TOKEN: TOKEN,
      TELEGRAM_BOT_API_ROOT: apiRoot,
      REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
    } as never,
  });
}

const SESSION = { cookie: 'reiwa_web_session=ws-1' };
/** What a browser attaches to the SPA's same-origin XHR POST. */
const SAME_ORIGIN = { origin: 'http://127.0.0.1' };

/** Whether `promise` has settled once the event loop has turned a few times — without advancing any fake clock. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 50 && !settled; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return settled;
}

beforeEach(() => {
  // Rebound to each case's admin client on first read, the way production binds it.
  setPolicyCache(null);
  resetChannelGateMemory();
});

afterEach(async () => {
  vi.useRealTimers();
  // Store writes and alerts outlive the answer; none may land in the next case.
  await settleChannelGateBackground();
  setPolicyCache(null);
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('the channel gate in the assembled app', () => {
  it("GET and the SPA's same-origin POST ask the operator's Bot API server with the bot token", async () => {
    const botApi = await startBotApi({ status: 'left' });
    const app = buildApp(botApi.apiRoot);

    const launch = await sendSocketless(app, { method: 'GET', url: '/api/v1/channel-gate', headers: SESSION });
    expect(launch).toMatchObject({ status: 200, body: { status: 'not-subscribed', joinUrl: JOIN_URL } });

    const recheck = await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/channel-gate/check',
      headers: { ...SESSION, ...SAME_ORIGIN },
      body: {},
    });
    expect(recheck).toMatchObject({ status: 200, body: { status: 'not-subscribed', joinUrl: JOIN_URL } });

    expect(botApi.calls).toEqual([
      { path: `/bot${TOKEN}/getChatMember`, payload: { chat_id: '@rezeis_news', user_id: 4242 } },
      { path: `/bot${TOKEN}/getChatMember`, payload: { chat_id: '@rezeis_news', user_id: 4242 } },
    ]);
  });

  it('refuses a POST with the session cookie but no cabinet Origin before Telegram is asked', async () => {
    const botApi = await startBotApi({ status: 'member' });
    const app = buildApp(botApi.apiRoot);

    const bare = await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/channel-gate/check',
      headers: SESSION,
      body: {},
    });
    expect(bare).toMatchObject({ status: 403, body: { message: 'Forbidden: origin required' } });

    const foreign = await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/channel-gate/check',
      headers: { ...SESSION, origin: 'https://evil.example' },
      body: {},
    });
    expect(foreign).toMatchObject({ status: 403, body: { message: 'Forbidden: origin not allowed' } });
    expect(botApi.calls).toEqual([]);
  });

  it('gives up on a Telegram that stops answering after 5 s — before the gate module\'s own 6 s deadline', async () => {
    const silent = await startBotApi(null);
    const app = buildApp(silent.apiRoot);
    // Only the timers: sockets, and the turns `settles` waits on, stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const launch = sendSocketless(app, { method: 'GET', url: '/api/v1/channel-gate', headers: SESSION });
    await silent.firstCall;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settles(launch), 'answered before the client timeout').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settles(launch), 'still waiting at 5 s').toBe(true);
    expect(await launch).toMatchObject({ status: 200, body: { status: 'unverified', joinUrl: JOIN_URL } });
  });

  it('reads a pass the bot left in the shared Redis while «Перепроверять подписку» is off', async () => {
    const botApi = await startBotApi({ status: 'left' });
    const redis = new FakeRedis();
    await redis.set('reiwa:channel-gate:v1:pass:@rezeis_news:4242', '1', 'PX', 60_000);
    const app = buildApp(botApi.apiRoot, { redis, channelRecheck: false });

    const launch = await sendSocketless(app, { method: 'GET', url: '/api/v1/channel-gate', headers: SESSION });
    expect(launch).toMatchObject({ status: 200, body: { status: 'subscribed', joinUrl: JOIN_URL } });
    expect(botApi.calls).toEqual([]);
  });
});

describe('createChatMemberApi', () => {
  it('is null without a bot token', () => {
    expect(createChatMemberApi({ BOT_TOKEN: undefined, TELEGRAM_BOT_API_ROOT: null })).toBeNull();
  });

  it('honours a timeout it is given', async () => {
    const silent = await startBotApi(null);
    const api = createChatMemberApi({ BOT_TOKEN: TOKEN, TELEGRAM_BOT_API_ROOT: silent.apiRoot }, 1);
    expect(api).not.toBeNull();

    const failure = await api!.getChatMember('@rezeis_news', 4242).then(
      () => null,
      (err: unknown) => err,
    );
    // grammY wraps its own deadline: the HttpError's message is generic, the cause names the seconds.
    expect(failure).toBeInstanceOf(HttpError);
    expect(String((failure as HttpError).error)).toContain("Request to 'getChatMember' timed out after 1 seconds");
    expect(silent.calls).toHaveLength(1);
  }, 10_000);
});
