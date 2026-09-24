/**
 * «Канал обязателен» in the Mini App: `GET /api/v1/channel-gate` and
 * `POST /api/v1/channel-gate/check`.
 *
 * The contract the SPA is written against is in the route's header; each case
 * below holds one clause of it. The Telegram side is a fake here — the gate
 * module's own handling of Telegram's answers is `test/bot/lib/
 * channel-gate.test.ts`, and the route against grammY's real client, mounted in
 * the real app, is `channel-gate-app.test.ts`.
 *
 * Windows and budgets are written as LITERALS, never imported: a spec that
 * reads the constant it guards agrees with any value the constant is changed
 * to. Where a window matters the clock is faked (`Date` only — timers and
 * sockets stay real).
 *
 * The policy is in the shape rezeis serves it (every key present, an empty
 * «ID канала» as `null`), because the gate was once switched off by specs that
 * handed it a policy rezeis never sends.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { GrammyError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChannelGateRouter } from '../../src/api/routes/channel-gate.js';
import {
  resetChannelGateMemory,
  settleChannelGateBackground,
  type ChatMemberApi,
} from '../../src/bot/lib/channel-gate.js';
import { UpstreamError } from '../../src/core/errors/index.js';
import { PolicyCache, setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import type { PlatformPolicyShape } from '../../src/infrastructure/admin-client/namespaces/system.js';
import { FakeRedis } from '../infrastructure/channel-gate/fake-redis.js';
import { sendSocketless, type SocketlessResponse } from './socketless-request.js';

/** `GET /api/internal/settings/platform-policy` with the gate on and only «Ссылка на канал» filled. */
function panelPolicy(overrides: Record<string, unknown> = {}): PlatformPolicyShape {
  return {
    accessMode: 'PUBLIC',
    rulesRequired: false,
    rulesLink: '',
    channelRequired: true,
    channelLink: 'https://t.me/rezeis_news',
    channelId: null,
    channelUsername: null,
    channelRecheck: true,
    requireTelegramWebCredentials: false,
    defaultCurrency: 'RUB',
    ...overrides,
  } as PlatformPolicyShape;
}

function usePolicy(policy: PlatformPolicyShape): void {
  setPolicyCache(new PolicyCache(async () => policy));
}

const JOIN_URL = 'https://t.me/rezeis_news';
const OFF = { status: 'off', joinUrl: null };
const TOO_MANY = 'Too many requests, please try again later';
const ACCOUNT = 'cm0account000000000000001';
const OTHER_ACCOUNT = 'cm0account000000000000002';
const LEGACY_COOKIE = { cookie: 'reiwa_session=legacy-1' };
/** A second legacy session, always present, for a different Telegram user. */
const OTHER_LEGACY_COOKIE = { cookie: 'reiwa_session=legacy-other' };
/** Where a pass of «Перепроверять подписку» OFF for Telegram user 4242 lives in the shared Redis. */
const PASS_KEY = 'reiwa:channel-gate:v1:pass:@rezeis_news:4242';

/** Test-only headers naming the WebSession of one request: its account, and its session id. */
const ACCOUNT_HEADER = 'x-test-account';
const SESSION_HEADER = 'x-test-session';

interface Harness {
  readonly app: express.Express;
  readonly getSession: ReturnType<typeof vi.fn>;
  readonly reportError: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly startupWarn: ReturnType<typeof vi.fn>;
  readonly destroyWebSession: ReturnType<typeof vi.fn>;
  readonly getChatMember: ReturnType<typeof vi.fn>;
}

function harness(options: {
  /** The WebSession's reiwa_id; absent means no WebSession (unless a request names one). */
  readonly account?: string;
  /** A legacy `reiwa_session=legacy-1` whose stored Telegram id is this. */
  readonly legacyTelegramId?: string;
  /** What the panel's session payload says, or how it fails. */
  readonly getSession?: (identity: { userId?: string }) => Promise<unknown>;
  /** What Telegram answers; `null` leaves the router to build its own client from the config. */
  readonly member?: (() => Promise<unknown>) | null;
  /** The Redis behind the API's session store — and so behind the gate's shared store. */
  readonly redis?: FakeRedis;
}): Harness {
  const getSession = vi.fn(options.getSession ?? (async () => ({ id: ACCOUNT, telegramId: '4242' })));
  const reportError = vi.fn(async () => ({}));
  const warn = vi.fn();
  const log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: () => log };
  const startupWarn = vi.fn();
  const processLogger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: startupWarn,
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
  const destroyWebSession = vi.fn(async () => undefined);
  const getChatMember = vi.fn(options.member ?? (async () => ({ status: 'left' })));

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = log;
    const named = req.headers[ACCOUNT_HEADER];
    const account = typeof named === 'string' ? named : options.account;
    const session = req.headers[SESSION_HEADER];
    req.webSession =
      account === undefined ? null : { userId: account, createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    req.webSessionId = account === undefined ? null : typeof session === 'string' ? session : `session-of-${account}`;
    req.destroyWebSession = destroyWebSession;
    next();
  });
  app.use(
    '/api/v1',
    createChannelGateRouter({
      adminClient: { user: { getSession }, system: { reportError } } as never,
      sessionStore: {
        get: async (id: string) => {
          if (id === 'legacy-other') return { telegramId: '5151', userId: 8, name: 'Bob', role: 'user', createdAt: 0 };
          return id === 'legacy-1' && options.legacyTelegramId !== undefined
            ? { telegramId: options.legacyTelegramId, userId: 7, name: 'Ann', role: 'user', createdAt: 0 }
            : null;
        },
        refresh: async () => undefined,
      } as never,
      webSessionStore: options.redis === undefined ? null : ({ getRedis: () => options.redis!.asRedis() } as never),
      // No BOT_TOKEN: a case that wants the route's own client says so with `member: null`.
      config: { NODE_ENV: 'test' } as never,
      logger: processLogger as never,
      ...(options.member === null ? {} : { chatMemberApi: { getChatMember } as unknown as ChatMemberApi }),
    }),
  );
  return { app, getSession, reportError, warn, startupWarn, destroyWebSession, getChatMember };
}

function gate(app: express.Express, headers: Record<string, string> = {}): Promise<SocketlessResponse> {
  return sendSocketless(app, { method: 'GET', url: '/api/v1/channel-gate', headers });
}

function check(app: express.Express, headers: Record<string, string> = {}): Promise<SocketlessResponse> {
  return sendSocketless(app, { method: 'POST', url: '/api/v1/channel-gate/check', headers, body: {} });
}

function warnings(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map((args) => String(typeof args[0] === 'string' ? args[0] : args[1]));
}

function said(warn: ReturnType<typeof vi.fn>, words: string): number {
  return warnings(warn).filter((line) => line.includes(words)).length;
}

/** The outage warning of a panel that could not say who an account is. */
const LOOKUP_WARNING = 'the panel could not say which Telegram user this account is';

function panelRefusing(status: number, body: string): () => Promise<never> {
  return async () => {
    throw new UpstreamError('GET', `/api/internal/user/session?userId=${ACCOUNT}`, status, body);
  };
}

beforeEach(() => {
  // Both are process singletons; a case must not inherit the previous one's.
  setPolicyCache(null);
  resetChannelGateMemory();
});

afterEach(async () => {
  // Store writes and alerts outlive the answer; none may land in the next case.
  await settleChannelGateBackground();
  setPolicyCache(null);
  vi.useRealTimers();
});

describe('who may ask', () => {
  it('answers 401 to a caller with no session, and asks neither the panel nor Telegram', async () => {
    usePolicy(panelPolicy());
    const h = harness({});

    expect(await gate(h.app)).toMatchObject({ status: 401, body: { message: 'Unauthorized' } });
    expect(await check(h.app)).toMatchObject({ status: 401, body: { message: 'Unauthorized' } });
    expect(h.getSession).not.toHaveBeenCalled();
    expect(h.getChatMember).not.toHaveBeenCalled();
  });

  it('answers a flood with no session 401 every time — never 429 — and spends no account\'s budget', async () => {
    usePolicy(panelPolicy());
    const h = harness({});

    for (let i = 1; i <= 31; i += 1) expect((await gate(h.app)).status, `GET ${i}`).toBe(401);
    for (let i = 1; i <= 11; i += 1) expect((await check(h.app)).status, `POST ${i}`).toBe(401);
    // A signed-in account behind the same address still has all ten checks.
    for (let i = 1; i <= 10; i += 1) {
      expect((await check(h.app, { [ACCOUNT_HEADER]: ACCOUNT })).status, `account POST ${i}`).toBe(200);
    }
  });

  it.each([
    ['blocked', 403, JSON.stringify({ code: 'USER_BLOCKED', message: 'USER_BLOCKED' })],
    ['deleted', 404, JSON.stringify({ message: 'User not found', error: 'Not Found', statusCode: 404 })],
  ])('ends the session of a %s account and answers 401, instead of letting it in unverified', async (_state, status, body) => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT, getSession: panelRefusing(status, body) });

    expect(await gate(h.app)).toMatchObject({ status: 401, body: { message: 'Unauthorized' } });
    expect(h.destroyWebSession).toHaveBeenCalledTimes(1);
    expect(h.getChatMember).not.toHaveBeenCalled();
    // It is an answer, not an outage, and is not logged as one.
    expect(said(h.warn, LOOKUP_WARNING)).toBe(0);
  });

  // Any other refusal says nothing about the account. Ending sessions over one
  // would sign every Mini App user out the moment the panel and the cabinet
  // disagreed about a token, or the panel lost a route in an upgrade.
  it.each([
    ['400, a request it will not read', 400, JSON.stringify({ message: ['userId must be a string'], error: 'Bad Request', statusCode: 400 })],
    ['401, a token reiwa and rezeis disagree on', 401, JSON.stringify({ message: 'Unauthorized', statusCode: 401 })],
    ['403 without USER_BLOCKED, its internal guard refusing the call', 403, JSON.stringify({ message: 'Forbidden resource', error: 'Forbidden', statusCode: 403 })],
    ['404 from a route this panel version lacks', 404, JSON.stringify({ message: `Cannot GET /api/internal/user/session?userId=${ACCOUNT}`, error: 'Not Found', statusCode: 404 })],
    ['409', 409, JSON.stringify({ message: 'Conflict', statusCode: 409 })],
  ])('keeps the session and answers "unverified" when the panel answers %s', async (_what, status, body) => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT, getSession: panelRefusing(status, body) });

    expect(await gate(h.app)).toMatchObject({ status: 200, body: { status: 'unverified', joinUrl: JOIN_URL } });
    expect(await check(h.app)).toMatchObject({ status: 200, body: { status: 'unverified', joinUrl: JOIN_URL } });
    expect(h.destroyWebSession).not.toHaveBeenCalled();
    expect(said(h.warn, LOOKUP_WARNING)).toBe(1);
  });
});

describe('status "off"', () => {
  it('while «Канал обязателен» is off — without reading the account or asking Telegram', async () => {
    usePolicy(panelPolicy({ channelRequired: false }));
    const h = harness({ account: ACCOUNT });

    expect(await gate(h.app)).toMatchObject({ status: 200, body: OFF });
    expect(await check(h.app)).toMatchObject({ status: 200, body: OFF });
    expect(h.getSession).not.toHaveBeenCalled();
    expect(h.getChatMember).not.toHaveBeenCalled();
  });

  it('for an account with no Telegram id — registered on the web, nobody to ask about', async () => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT, getSession: async () => ({ id: ACCOUNT, telegramId: null }) });

    expect((await gate(h.app)).body).toEqual(OFF);
    expect((await check(h.app)).body).toEqual(OFF);
    expect(h.getSession).toHaveBeenCalledWith({ userId: ACCOUNT });
    expect(h.getChatMember).not.toHaveBeenCalled();
  });

  it('when the panel does not answer and no policy is cached — failing open, said once per 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setPolicyCache(
      new PolicyCache(async () => {
        throw new Error('connect ECONNREFUSED rezeis:8000');
      }),
    );
    const h = harness({ account: ACCOUNT });
    const start = Date.now();

    for (let i = 0; i < 3; i += 1) expect(await gate(h.app)).toMatchObject({ status: 200, body: OFF });
    expect(said(h.warn, 'no policy is cached')).toBe(1);

    vi.setSystemTime(start + 599_999);
    await gate(h.app);
    expect(said(h.warn, 'no policy is cached')).toBe(1);

    vi.setSystemTime(start + 600_000);
    await gate(h.app);
    expect(said(h.warn, 'no policy is cached')).toBe(2);
    expect(h.getChatMember).not.toHaveBeenCalled();
  });

  it('when reading the policy throws — a 200 "off", not a 500, said once rather than per request', async () => {
    setPolicyCache({
      get: async () => {
        throw new Error('policy cache exploded');
      },
    } as unknown as PolicyCache);
    const h = harness({ account: ACCOUNT });

    for (let i = 0; i < 3; i += 1) expect(await check(h.app)).toMatchObject({ status: 200, body: OFF });
    expect(said(h.warn, 'could not be read')).toBe(1);
  });

  // `PolicyCache` reads a non-object answer as a failed read; this is the route
  // standing on its own should a cache ever hand one out, as the gate module and
  // the bot middleware do.
  it.each([
    ['null', null],
    ['a string', '<html>maintenance</html>'],
  ])('when the policy cache hands out %s — a 200 "off", not a 500, said once', async (_what, value) => {
    setPolicyCache({ get: async () => value } as unknown as PolicyCache);
    const h = harness({ account: ACCOUNT });

    for (let i = 0; i < 3; i += 1) expect(await gate(h.app)).toMatchObject({ status: 200, body: OFF });
    expect(await check(h.app)).toMatchObject({ status: 200, body: OFF });
    expect(said(h.warn, 'not a policy')).toBe(1);
    expect(h.getSession).not.toHaveBeenCalled();
  });

  it('reads a Telegram id that is not a safe positive integer as no Telegram id at all', async () => {
    usePolicy(panelPolicy());
    // Past MAX_SAFE_INTEGER a number rounds to a DIFFERENT id: asking Telegram
    // about it would check somebody else. A negative id is a chat, not a user.
    for (const stored of ['9007199254740993', '-1001234567890', '0', '12abc', '']) {
      const legacy = harness({ legacyTelegramId: stored });
      expect((await gate(legacy.app, LEGACY_COOKIE)).body, stored).toEqual(OFF);
      expect(legacy.getChatMember, stored).not.toHaveBeenCalled();
    }
    const web = harness({ account: ACCOUNT, getSession: async () => ({ telegramId: '9007199254740993' }) });
    expect((await gate(web.app)).body).toEqual(OFF);
    expect(web.getChatMember).not.toHaveBeenCalled();
  });
});

describe('what Telegram says', () => {
  it('"not-subscribed" carries the join link, asked about the account\'s own Telegram user', async () => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT });

    const response = await gate(h.app);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'not-subscribed', joinUrl: JOIN_URL });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(h.getChatMember).toHaveBeenCalledWith('@rezeis_news', 4242);
  });

  it('GET answers from the memory of a pass; POST /check asks Telegram, sharing one answer only within 2 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT, member: async () => ({ status: 'member' }) });

    expect((await gate(h.app)).body).toEqual({ status: 'subscribed', joinUrl: JOIN_URL });
    // Three seconds on: past the 2 s a fresh check would share, inside the minute a pass is trusted.
    vi.setSystemTime(Date.now() + 3_000);
    expect((await gate(h.app)).body).toEqual({ status: 'subscribed', joinUrl: JOIN_URL });
    expect(h.getChatMember).toHaveBeenCalledTimes(1);

    // «✅ Я подписался» right after a pass still asks: a remembered answer is
    // exactly what it must not trust.
    const fresh = await check(h.app);
    expect(fresh).toMatchObject({ status: 200, body: { status: 'subscribed', joinUrl: JOIN_URL } });
    expect(fresh.headers['cache-control']).toBe('no-store');
    expect(h.getChatMember).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 1_999);
    await check(h.app);
    expect(h.getChatMember).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 1);
    await check(h.app);
    expect(h.getChatMember).toHaveBeenCalledTimes(3);
  });

  it('a GET keeps saying "not subscribed" for a few seconds, while POST /check sees a join at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    usePolicy(panelPolicy());
    let status = 'left';
    const h = harness({ account: ACCOUNT, member: async () => ({ status }) });

    expect((await gate(h.app)).body).toEqual({ status: 'not-subscribed', joinUrl: JOIN_URL });
    // The user joins the channel and comes back to the Mini App.
    status = 'member';
    vi.setSystemTime(Date.now() + 5_000);
    expect((await gate(h.app)).body).toEqual({ status: 'not-subscribed', joinUrl: JOIN_URL });
    expect(h.getChatMember).toHaveBeenCalledTimes(1);

    expect((await check(h.app)).body).toEqual({ status: 'subscribed', joinUrl: JOIN_URL });
    expect(h.getChatMember).toHaveBeenCalledTimes(2);
    // And the join sticks for the next launch.
    expect((await gate(h.app)).body).toEqual({ status: 'subscribed', joinUrl: JOIN_URL });
  });

  it('a legacy Telegram session is checked by the id it carries, with no panel read', async () => {
    usePolicy(panelPolicy());
    const h = harness({ legacyTelegramId: '4343', member: async () => ({ status: 'member' }) });

    expect((await check(h.app, LEGACY_COOKIE)).body).toEqual({ status: 'subscribed', joinUrl: JOIN_URL });
    expect(h.getChatMember).toHaveBeenCalledWith('@rezeis_news', 4343);
    expect(h.getSession).not.toHaveBeenCalled();
  });

  it("with both sessions on one request, the account's Telegram id wins over the legacy cookie's", async () => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT, legacyTelegramId: '9999' });

    await gate(h.app, LEGACY_COOKIE);
    expect(h.getChatMember.mock.calls.map((call) => call[1])).toEqual([4242]);
  });
});

describe('status "unverified" — the gate is on, the user is let in', () => {
  it('when the API has no BOT_TOKEN, logged once rather than per request', async () => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT, member: null });

    expect((await gate(h.app)).body).toEqual({ status: 'unverified', joinUrl: JOIN_URL });
    expect((await check(h.app)).body).toEqual({ status: 'unverified', joinUrl: JOIN_URL });
    expect(said(h.warn, 'BOT_TOKEN')).toBe(1);
  });

  it('when Telegram refuses (bot not a channel admin) — and the operator is told, under the API', async () => {
    usePolicy(panelPolicy({ channelId: '-1001234567890' }));
    const refusal = new GrammyError(
      "Call to 'getChatMember' failed!",
      { ok: false, error_code: 400, description: 'Bad Request: member list is inaccessible' },
      'getChatMember',
      {},
    );
    const h = harness({ account: ACCOUNT, member: async () => Promise.reject(refusal) });

    expect(await check(h.app)).toMatchObject({ status: 200, body: { status: 'unverified', joinUrl: JOIN_URL } });
    expect(h.getChatMember).toHaveBeenCalledWith('-1001234567890', 4242);
    // The alert runs after the answer.
    await settleChannelGateBackground();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.objectContaining({ source: 'api', level: 'warning' }));
    // Through the request's own logger, so the line carries the request id.
    expect(said(h.warn, 'member list is inaccessible')).toBe(1);
  });

  it('when the panel cannot say which Telegram user the account is — logged, session kept, not remembered', async () => {
    usePolicy(panelPolicy());
    let panelUp = false;
    const h = harness({
      account: ACCOUNT,
      getSession: async () => {
        if (!panelUp) throw new UpstreamError('GET', `/api/internal/user/session?userId=${ACCOUNT}`, 502, 'Bad Gateway');
        return { telegramId: '4242' };
      },
    });

    expect(await gate(h.app)).toMatchObject({ status: 200, body: { status: 'unverified', joinUrl: JOIN_URL } });
    expect(said(h.warn, LOOKUP_WARNING)).toBe(1);
    expect(h.destroyWebSession).not.toHaveBeenCalled();
    expect(h.getChatMember).not.toHaveBeenCalled();

    panelUp = true;
    expect((await gate(h.app)).body).toEqual({ status: 'not-subscribed', joinUrl: JOIN_URL });
    expect(h.getSession).toHaveBeenCalledTimes(2);
  });

  it('says so once per 10 minutes through a panel outage, while still asking the panel on every launch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT, getSession: panelRefusing(502, 'Bad Gateway') });
    const start = Date.now();

    for (let i = 0; i < 3; i += 1) {
      expect((await gate(h.app)).body).toEqual({ status: 'unverified', joinUrl: JOIN_URL });
    }
    expect(said(h.warn, LOOKUP_WARNING)).toBe(1);
    expect(h.getSession).toHaveBeenCalledTimes(3);

    vi.setSystemTime(start + 599_999);
    await gate(h.app);
    expect(said(h.warn, LOOKUP_WARNING)).toBe(1);

    vi.setSystemTime(start + 600_000);
    await gate(h.app);
    expect(said(h.warn, LOOKUP_WARNING)).toBe(2);
  });
});

describe('budgets per account', () => {
  it('refuses the 11th POST /check within 60 s with the shared 429 — and the refused one reaches nobody', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT });
    const start = Date.now();

    for (let i = 1; i <= 10; i += 1) {
      expect((await check(h.app)).status, `check ${i}`).toBe(200);
      // Past the 2 s in which checks of one user share an answer, so each allowed one asks Telegram.
      vi.setSystemTime(Date.now() + 2_001);
    }
    expect(h.getChatMember).toHaveBeenCalledTimes(10);

    // 20.01 s into the minute: 39.99 s left, answered as 40.
    const refused = await check(h.app);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ message: TOO_MANY, retryAfter: 40 });
    expect(refused.headers['retry-after']).toBe('40');
    expect(h.getChatMember).toHaveBeenCalledTimes(10);

    vi.setSystemTime(start + 59_999);
    expect((await check(h.app)).status).toBe(429);
    vi.setSystemTime(start + 60_000);
    expect((await check(h.app)).status).toBe(200);
  });

  it('refuses the 31st GET within 60 s with the same 429, on a budget of its own', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    usePolicy(panelPolicy({ channelRequired: false }));
    const h = harness({ account: ACCOUNT });
    const start = Date.now();

    for (let i = 1; i <= 30; i += 1) expect((await gate(h.app)).status, `launch ${i}`).toBe(200);

    vi.setSystemTime(start + 30_000);
    const refused = await gate(h.app);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ message: TOO_MANY, retryAfter: 30 });
    expect(refused.headers['retry-after']).toBe('30');
    // The fresh check keeps its own ten.
    expect((await check(h.app)).status).toBe(200);

    vi.setSystemTime(start + 59_999);
    expect((await gate(h.app)).status).toBe(429);
    vi.setSystemTime(start + 60_000);
    expect((await gate(h.app)).status).toBe(200);
  });

  it('counts per account, not per address: another account on the same IP still gets through', async () => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT });

    for (let i = 0; i < 10; i += 1) await check(h.app);
    expect((await check(h.app)).status).toBe(429);
    expect((await check(h.app, { [ACCOUNT_HEADER]: OTHER_ACCOUNT })).status).toBe(200);
  });

  it('counts every session of one account against the same POST budget, not a budget per session', async () => {
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT });

    for (let i = 0; i < 10; i += 1) expect((await check(h.app, { [SESSION_HEADER]: 'phone' })).status).toBe(200);
    expect((await check(h.app, { [SESSION_HEADER]: 'desktop' })).status).toBe(429);
  });

  it('counts every session of one account against the same GET budget, not a budget per session', async () => {
    usePolicy(panelPolicy({ channelRequired: false }));
    const h = harness({ account: ACCOUNT });

    for (let i = 1; i <= 30; i += 1) {
      expect((await gate(h.app, { [SESSION_HEADER]: 'phone' })).status, `launch ${i}`).toBe(200);
    }
    expect((await gate(h.app, { [SESSION_HEADER]: 'desktop' })).status).toBe(429);
  });

  it('counts a legacy Telegram session by its Telegram user, apart from every other one', async () => {
    usePolicy(panelPolicy());
    const h = harness({ legacyTelegramId: '4343' });

    for (let i = 0; i < 10; i += 1) await check(h.app, LEGACY_COOKIE);
    expect((await check(h.app, LEGACY_COOKIE)).status).toBe(429);
    expect((await check(h.app, OTHER_LEGACY_COOKIE)).status).toBe(200);
    expect(h.getChatMember.mock.calls.at(-1)).toEqual(['@rezeis_news', 5151]);
  });
});

describe('the account → Telegram id memory', () => {
  it("reads the account's Telegram id from the panel once per 5 minutes, not once per launch", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    usePolicy(panelPolicy());
    const h = harness({ account: ACCOUNT });
    const start = Date.now();

    await gate(h.app);
    await gate(h.app);
    await check(h.app);
    expect(h.getSession).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + 299_999);
    await gate(h.app);
    expect(h.getSession).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + 300_000);
    await gate(h.app);
    expect(h.getSession).toHaveBeenCalledTimes(2);
  });
});

describe('the store the bot shares (REDIS_URL)', () => {
  it('lets in, without asking Telegram, a user the bot let in while «Перепроверять подписку» is off', async () => {
    usePolicy(panelPolicy({ channelRecheck: false }));
    const redis = new FakeRedis();
    // What reiwa-bot left behind: the key both processes read.
    await redis.set(PASS_KEY, '1', 'PX', 60_000);
    const h = harness({ account: ACCOUNT, redis });

    expect((await gate(h.app)).body).toEqual({ status: 'subscribed', joinUrl: JOIN_URL });
    expect(h.getChatMember).not.toHaveBeenCalled();
    expect(redis.calls.filter((call) => call.command === 'exists').map((call) => call.args)).toEqual([[PASS_KEY]]);
  });

  it('leaves the pass it learnt in that store, for the bot to read', async () => {
    usePolicy(panelPolicy({ channelRecheck: false }));
    const redis = new FakeRedis();
    const h = harness({ account: ACCOUNT, redis, member: async () => ({ status: 'member' }) });

    expect((await gate(h.app)).body).toEqual({ status: 'subscribed', joinUrl: JOIN_URL });
    // The write runs after the answer.
    await settleChannelGateBackground();
    expect(redis.keys()).toEqual([PASS_KEY]);
  });

  it('without REDIS_URL says at start, once, that the gate remembers in this process only — and not with it', () => {
    const without = harness({});
    expect(said(without.startupWarn, 'REDIS_URL is not set')).toBe(1);
    expect(without.startupWarn).toHaveBeenCalledTimes(1);

    const withRedis = harness({ redis: new FakeRedis() });
    expect(withRedis.startupWarn).not.toHaveBeenCalled();
  });
});
