/**
 * The cabinet's half of "forgot password": `/auth/recover`,
 * `/auth/reset-password[/inspect]` and `/auth/recover/subscription`.
 *
 * The panel decides; these routes must not undo what it decided. Three things
 * in particular are the cabinet's to get right:
 *   - "forgot password" answers every visitor the SAME, whatever the panel
 *     said about the account (the panel's `method` is for its own logs);
 *   - the link base the panel builds on is THIS cabinet's configured address —
 *     a visitor's Host header must not be able to point a victim's reset link
 *     at another site;
 *   - a spent reset link signs the customer in exactly like login does, and a
 *     refused one signs nobody in.
 *
 * The admin client is faked through the namespace methods the routes call,
 * typed by the real namespace, so a renamed or reshaped method fails to compile.
 * Socket-free for the reason `socketless-request.ts` gives.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { describe, expect, it, vi } from 'vitest';

import type { AdminClient } from '../../src/lib/admin-client.js';
import type { ReiwaConfig } from '../../src/config.js';
import type { WebSessionStore } from '../../src/infrastructure/redis/session.js';
import type { WebAuthNamespace } from '../../src/infrastructure/admin-client/namespaces/web-auth.js';
import { UpstreamError } from '../../src/core/errors/index.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { sendSocketless, type SocketlessResponse } from './socketless-request.js';

type ResetWebAuth = Pick<
  WebAuthNamespace,
  | 'requestPasswordReset'
  | 'inspectPasswordReset'
  | 'consumePasswordReset'
  | 'recoverPasswordBySubscription'
  | 'login'
  | 'sendFirstPasswordLink'
>;

const TOKEN = 'c'.repeat(64);
const HASH = 'd'.repeat(64);

let address = 0;
/** A fresh client address per request, so the in-memory limiters never meet. */
function nextAddress(): string {
  address += 1;
  return `198.51.100.${address % 250}`;
}

function buildApp(
  webAuth: Partial<ResetWebAuth>,
  options: { readonly domain?: string; readonly sessionFails?: boolean } = {},
) {
  const createWebSession = vi.fn(async (_userId: string) => {
    if (options.sessionFails === true) throw new Error('redis is down');
    return 'session-1';
  });
  /** Every key a Redis limiter counted, in order. */
  const limiterKeys: string[] = [];
  const destroyWebSession = vi.fn(async () => undefined);
  const unexpected = (name: string) => async () => {
    throw new Error(`the route called ${name}, which this case did not expect`);
  };
  const namespace: ResetWebAuth = {
    requestPasswordReset: webAuth.requestPasswordReset ?? unexpected('requestPasswordReset'),
    inspectPasswordReset: webAuth.inspectPasswordReset ?? unexpected('inspectPasswordReset'),
    consumePasswordReset: webAuth.consumePasswordReset ?? unexpected('consumePasswordReset'),
    recoverPasswordBySubscription:
      webAuth.recoverPasswordBySubscription ?? unexpected('recoverPasswordBySubscription'),
    login: webAuth.login ?? unexpected('login'),
    sendFirstPasswordLink: webAuth.sendFirstPasswordLink ?? unexpected('sendFirstPasswordLink'),
  };

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.createWebSession = createWebSession;
    req.destroyWebSession = destroyWebSession;
    next();
  });
  app.use(
    '/api/v1',
    createAuthRouter({
      adminClient: { webAuth: namespace } as unknown as AdminClient,
      sessionStore: null,
      // Lets the Redis limiters through — one hit in a 60 s window — and
      // remembers which counter each request was charged to.
      webSessionStore: {
        getRedis: () => ({
          get: async () => null,
          eval: async (_script: string, _keys: number, key: string) => {
            limiterKeys.push(key);
            return [1, 60];
          },
        }),
      } as unknown as WebSessionStore,
      config: {
        NODE_ENV: 'test',
        REIWA_DOMAIN: options.domain ?? 'cabinet.example.com',
      } as unknown as ReiwaConfig,
    }),
  );
  return { app, createWebSession, destroyWebSession, limiterKeys };
}

function post(
  app: express.Express,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<SocketlessResponse> {
  return sendSocketless(app, {
    method: 'POST',
    url,
    body,
    headers: { 'x-forwarded-for': nextAddress(), ...headers },
  });
}

describe('POST /auth/recover — one answer for everybody', () => {
  it('answers an existing, a linked, an unreachable and an unknown login identically', async () => {
    const answers = new Map<string, 'telegram' | 'email' | 'none'>([
      ['alice', 'telegram'],
      ['bob', 'email'],
      ['carol', 'none'],
      ['nobody', 'none'],
    ]);
    const requestPasswordReset = vi.fn(async (identifier: string, _cabinetUrl: string | null) => ({
      method: answers.get(identifier) ?? ('none' as const),
      resetLinks: true as const,
    }));
    const { app } = buildApp({ requestPasswordReset });

    const responses = await Promise.all(
      [...answers.keys()].map((username) => post(app, '/api/v1/auth/recover', { username })),
    );

    expect(requestPasswordReset).toHaveBeenCalledTimes(4);
    const [first, ...rest] = responses;
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      status: 'accepted',
      message: 'If this login exists and has Telegram or an email linked, a reset link has been sent.',
    });
    for (const response of rest) {
      expect(response.status).toBe(first.status);
      expect(response.body).toEqual(first.body);
    }
    expect(JSON.stringify(responses.map((response) => response.body))).not.toMatch(/telegram|"email"|method/);
  });

  it('builds links on the configured cabinet address, whatever Host the visitor sends', async () => {
    const requestPasswordReset = vi.fn(async (_identifier: string, _cabinetUrl: string | null) => ({
      method: 'telegram' as const,
      resetLinks: true as const,
    }));
    const { app } = buildApp({ requestPasswordReset }, { domain: 'cabinet.example.com' });

    await post(app, '/api/v1/auth/recover', { username: 'alice@example.com' }, {
      host: 'evil.example.net',
      'x-forwarded-host': 'evil.example.net',
    });

    expect(requestPasswordReset.mock.calls).toEqual([['alice@example.com', 'https://cabinet.example.com']]);
  });

  it('says "unavailable" — to everybody — when the panel does not send reset links', async () => {
    const oldPanel = buildApp({
      requestPasswordReset: async () => {
        throw new UpstreamError('POST', '/api/internal/web-auth/password-reset/request', 404, 'Cannot POST');
      },
    });
    const noMarker = buildApp({ requestPasswordReset: async () => ({ method: 'telegram' as const }) });

    for (const { app } of [oldPanel, noMarker]) {
      const response = await post(app, '/api/v1/auth/recover', { username: 'alice' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'unavailable',
        message: 'Password recovery by link is not available. Please contact support.',
      });
    }
  });

  it('reports a panel failure as unavailable-for-now, not as sent', async () => {
    const { app } = buildApp({
      requestPasswordReset: async () => {
        throw new UpstreamError('POST', '/api/internal/web-auth/password-reset/request', 500, 'Internal server error');
      },
    });

    const response = await post(app, '/api/v1/auth/recover', { username: 'alice' });

    expect(response.status).toBe(503);
  });
});

describe('POST /auth/reset-password', () => {
  it('sets the password and signs the customer in, replacing whoever was signed in here', async () => {
    const consumePasswordReset = vi.fn(async (_token: string, _password: string) => ({
      status: 'ok' as const,
      userId: 'user-7',
      login: 'alice',
    }));
    const { app, createWebSession, destroyWebSession } = buildApp({ consumePasswordReset });

    const response = await post(app, '/api/v1/auth/reset-password', { token: TOKEN, passwordHash: HASH });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, redirectUrl: '/dashboard', login: 'alice' });
    expect(consumePasswordReset.mock.calls).toEqual([[TOKEN, HASH]]);
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
    expect(createWebSession.mock.calls).toEqual([['user-7']]);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('opens the new session after the moment the reset signed every other session out', async () => {
    // The panel ends every session of the account that started before the
    // reset. The one opened here must not be among them, whatever this
    // server's clock says against the panel's — so it counts from that moment.
    const sessionsRevokedAt = '2026-09-18T12:00:00.123Z';
    const { app, createWebSession } = buildApp({
      consumePasswordReset: async () => ({ status: 'ok' as const, userId: 'user-7', login: 'alice', sessionsRevokedAt }),
    });

    const response = await post(app, '/api/v1/auth/reset-password', { token: TOKEN, passwordHash: HASH });

    expect(response.status).toBe(200);
    expect(createWebSession.mock.calls).toEqual([['user-7', { authFloor: Date.parse(sessionsRevokedAt) }]]);
  });

  it('signs nobody in for a used or expired link, and says which', async () => {
    for (const [status, code] of [
      ['used', 'RESET_LINK_USED'],
      ['expired', 'RESET_LINK_EXPIRED'],
    ] as const) {
      const { app, createWebSession } = buildApp({ consumePasswordReset: async () => ({ status }) });

      const response = await post(app, '/api/v1/auth/reset-password', { token: TOKEN, passwordHash: HASH });

      expect(response.status).toBe(410);
      expect((response.body as { code?: string }).code).toBe(code);
      expect(createWebSession).not.toHaveBeenCalled();
    }
  });

  it('refuses a malformed token or password without asking the panel', async () => {
    const { app } = buildApp({});
    for (const body of [{ token: 'short', passwordHash: HASH }, { token: TOKEN, passwordHash: 'plain password' }, {}]) {
      const response = await post(app, '/api/v1/auth/reset-password', body);
      expect(response.status).toBe(400);
    }
  });

  it('says the password was changed, and names the login, when only the session could not be opened', async () => {
    const { app } = buildApp(
      { consumePasswordReset: async () => ({ status: 'ok' as const, userId: 'user-7', login: 'Alice' }) },
      { sessionFails: true },
    );

    const response = await post(app, '/api/v1/auth/reset-password', { token: TOKEN, passwordHash: HASH });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: 'SESSION_FAILED',
      message: 'Password changed but session setup failed. Please sign in.',
      login: 'Alice',
    });
  });
});

describe('POST /auth/login — an account imported without a password', () => {
  const refusedByPanel = async (): Promise<never> => {
    throw new UpstreamError('POST', '/api/internal/web-auth/login', 401, '{"message":"Invalid login or password"}');
  };

  it('opens no session, has the owner sent a reset link, and says where it went', async () => {
    const sendFirstPasswordLink = vi.fn<ResetWebAuth['sendFirstPasswordLink']>(async () => ({
      status: 'sent',
      channel: 'telegram',
    }));
    const { app, createWebSession } = buildApp({ login: refusedByPanel, sendFirstPasswordLink });

    const response = await post(
      app,
      '/api/v1/auth/login',
      { username: 'imported_user', passwordHash: HASH },
      { host: 'evil.example.net', 'x-forwarded-host': 'evil.example.net' },
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: 'PASSWORD_NOT_SET',
      delivery: 'telegram',
      message: 'This account has no password yet',
    });
    expect(createWebSession).not.toHaveBeenCalled();
    // The link is built on the configured cabinet address, never the visitor's Host.
    expect(sendFirstPasswordLink.mock.calls).toEqual([['imported_user', 'https://cabinet.example.com']]);
  });

  it('names each way the link could (not) go', async () => {
    const cases: Array<[Awaited<ReturnType<ResetWebAuth['sendFirstPasswordLink']>>, string]> = [
      [{ status: 'sent', channel: 'email' }, 'email'],
      [{ status: 'hourly_limit' }, 'hourly_limit'],
      [{ status: 'use_bot' }, 'bot'],
      [{ status: 'unavailable' }, 'unavailable'],
    ];
    for (const [answer, delivery] of cases) {
      const { app } = buildApp({ login: refusedByPanel, sendFirstPasswordLink: async () => answer });
      const response = await post(app, '/api/v1/auth/login', { username: 'imported_user', passwordHash: HASH });
      expect(response.status).toBe(401);
      expect((response.body as { delivery?: string }).delivery).toBe(delivery);
    }
  });

  it('keeps the ordinary refusal for every other login, and for a panel without the route', async () => {
    const ordinary = { message: 'Invalid username or password' };
    const notApplicable = buildApp({
      login: refusedByPanel,
      sendFirstPasswordLink: async () => ({ status: 'not_applicable' as const }),
    });
    const olderPanel = buildApp({
      login: refusedByPanel,
      sendFirstPasswordLink: async () => {
        throw new UpstreamError('POST', '/api/internal/web-auth/password-reset/first-password', 404, 'Cannot POST');
      },
    });

    for (const { app } of [notApplicable, olderPanel]) {
      const response = await post(app, '/api/v1/auth/login', { username: 'alice', passwordHash: HASH });
      expect(response.status).toBe(401);
      expect(response.body).toEqual(ordinary);
    }
  });

  it('does not ask about a first password when the panel failed rather than refused', async () => {
    const sendFirstPasswordLink = vi.fn<ResetWebAuth['sendFirstPasswordLink']>();
    const { app } = buildApp({
      login: async () => {
        throw new UpstreamError('POST', '/api/internal/web-auth/login', 500, 'Internal server error');
      },
      sendFirstPasswordLink,
    });

    const response = await post(app, '/api/v1/auth/login', { username: 'imported_user', passwordHash: HASH });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'Invalid username or password' });
    expect(sendFirstPasswordLink).not.toHaveBeenCalled();
  });
});

describe('the reset routes have budgets of their own', () => {
  it('charges each route to its own counter, keyed by the /64 of an IPv6 visitor', async () => {
    const { app, limiterKeys } = buildApp({
      consumePasswordReset: async () => ({ status: 'used' as const }),
      inspectPasswordReset: async () => ({ status: 'expired' as const }),
      recoverPasswordBySubscription: async () => ({ status: 'mismatch' as const }),
    });
    const visitor = { 'x-forwarded-for': '2001:db8:1:2::5' };

    await post(app, '/api/v1/auth/reset-password', { token: TOKEN, passwordHash: HASH }, visitor);
    await post(app, '/api/v1/auth/reset-password/inspect', { token: TOKEN }, visitor);
    await post(app, '/api/v1/auth/recover/subscription', { link: 'AliceShort01q', username: 'alice' }, visitor);

    expect(limiterKeys).toEqual([
      'rate:pwreset:2001:db8:1:2::/64',
      'rate:pwreset_inspect:2001:db8:1:2::/64',
      'rate:recover_sub:2001:db8:1:2::/64',
    ]);
  });

  it('does not share the in-memory budget of the Mini App bootstrap and linking', async () => {
    // `authLimiter` allows 20 per 15 minutes per address. These routes are
    // metered by their own Redis counters, which this fake always lets through.
    const { app } = buildApp({
      inspectPasswordReset: async () => ({ status: 'expired' as const }),
      recoverPasswordBySubscription: async () => ({ status: 'mismatch' as const }),
    });
    const visitor = { 'x-forwarded-for': '203.0.113.201' };

    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      statuses.push((await post(app, '/api/v1/auth/reset-password/inspect', { token: TOKEN }, visitor)).status);
      statuses.push(
        (await post(app, '/api/v1/auth/recover/subscription', { link: 'AliceShort01q', username: 'alice' }, visitor))
          .status,
      );
    }

    expect(statuses.filter((status) => status === 429)).toEqual([]);
  });
});

describe('POST /auth/reset-password/inspect', () => {
  it('passes the panel verdict through and spends nothing', async () => {
    const inspectPasswordReset = vi
      .fn<ResetWebAuth['inspectPasswordReset']>()
      .mockResolvedValueOnce({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00.000Z' })
      .mockResolvedValueOnce({ status: 'used' })
      .mockResolvedValueOnce({ status: 'expired' });
    const { app } = buildApp({ inspectPasswordReset });

    const bodies = [];
    for (let i = 0; i < 3; i += 1) bodies.push((await post(app, '/api/v1/auth/reset-password/inspect', { token: TOKEN })).body);

    expect(bodies).toEqual([
      { status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00.000Z' },
      { status: 'used' },
      { status: 'expired' },
    ]);
  });

  it('calls a malformed token expired without asking the panel', async () => {
    const { app } = buildApp({});
    const response = await post(app, '/api/v1/auth/reset-password/inspect', { token: 'x' });
    expect(response.body).toEqual({ status: 'expired' });
  });
});

describe('POST /auth/recover/subscription', () => {
  it('hands the reset token back in the body, never in a redirect, and forwards the visitor address', async () => {
    const recoverPasswordBySubscription = vi.fn<ResetWebAuth['recoverPasswordBySubscription']>(async () => ({
      status: 'verified',
      token: TOKEN,
      login: 'alice',
      expiresAt: '2026-09-18T12:15:00.000Z',
    }));
    const { app } = buildApp({ recoverPasswordBySubscription });

    const response = await post(
      app,
      '/api/v1/auth/recover/subscription',
      { link: ' https://sub.example.com/AliceShort01q ', username: ' alice ' },
      { 'x-forwarded-for': '203.0.113.77' },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'verified',
      success: true,
      token: TOKEN,
      login: 'alice',
      expiresAt: '2026-09-18T12:15:00.000Z',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.location).toBeUndefined();
    expect(recoverPasswordBySubscription.mock.calls).toEqual([
      [
        {
          link: 'https://sub.example.com/AliceShort01q',
          login: 'alice',
          clientIp: '203.0.113.77',
          cabinetUrl: 'https://cabinet.example.com',
        },
      ],
    ]);
  });

  it('gives an account with a channel the "forgot password" form’s one answer, word for word', async () => {
    const recoverPasswordBySubscription = vi.fn<ResetWebAuth['recoverPasswordBySubscription']>(async () => ({
      status: 'sent_to_channels',
    }));
    const { app } = buildApp({
      recoverPasswordBySubscription,
      requestPasswordReset: async () => ({ method: 'none' as const, resetLinks: true as const }),
    });

    const bySubscription = await post(
      app,
      '/api/v1/auth/recover/subscription',
      { link: 'AliceShort01q', username: 'alice' },
      { host: 'evil.example.net', 'x-forwarded-host': 'evil.example.net' },
    );
    const byForm = await post(app, '/api/v1/auth/recover', { username: 'somebody' });

    expect(bySubscription.status).toBe(200);
    expect(bySubscription.body).toEqual(byForm.body);
    expect(bySubscription.body).toEqual({
      status: 'accepted',
      message: 'If this login exists and has Telegram or an email linked, a reset link has been sent.',
    });
    // The link sent to the account's channels is built on the configured
    // address, whatever Host the visitor sent.
    expect(recoverPasswordBySubscription.mock.calls[0]?.[0].cabinetUrl).toBe('https://cabinet.example.com');
  });

  it('answers every failed check the same way', async () => {
    const { app } = buildApp({ recoverPasswordBySubscription: async () => ({ status: 'mismatch' as const }) });

    const wrongLink = await post(app, '/api/v1/auth/recover/subscription', { link: 'https://x.example/NoSuch01', username: 'alice' });
    const wrongLogin = await post(app, '/api/v1/auth/recover/subscription', { link: 'AliceShort01q', username: 'zed' });

    expect(wrongLink.status).toBe(400);
    expect(wrongLink.body).toEqual({ code: 'NOT_VERIFIED', message: 'Could not verify the link and the login' });
    expect(wrongLogin.status).toBe(wrongLink.status);
    expect(wrongLogin.body).toEqual(wrongLink.body);
  });

  it('says the path is switched off — the same to every visitor — when the operator turned it off', async () => {
    const { app } = buildApp({ recoverPasswordBySubscription: async () => ({ status: 'disabled' as const }) });

    const matching = await post(app, '/api/v1/auth/recover/subscription', { link: 'AliceShort01q', username: 'alice' });
    const nonsense = await post(app, '/api/v1/auth/recover/subscription', { link: 'NoSuchThing1', username: 'zed' });

    expect(matching.status).toBe(403);
    expect(matching.body).toEqual({
      code: 'RECOVERY_DISABLED',
      message: 'Password recovery by subscription link is turned off',
    });
    expect(nonsense.status).toBe(matching.status);
    expect(nonsense.body).toEqual(matching.body);
  });

  it('passes the panel budget on as a 429 with Retry-After', async () => {
    const { app } = buildApp({
      recoverPasswordBySubscription: async () => ({ status: 'rate_limited' as const, retryAfterSeconds: 3600 }),
    });

    const response = await post(app, '/api/v1/auth/recover/subscription', { link: 'AliceShort01q', username: 'alice' });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('3600');
    expect(response.body).toEqual({ code: 'RATE_LIMITED', retryAfter: 3600 });
  });
});
