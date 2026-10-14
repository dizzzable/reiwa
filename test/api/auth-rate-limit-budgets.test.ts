/**
 * Sign-in budgets that customers behind one address can live with.
 *
 * Several customers share an address (a carrier NAT, a VPN exit, a CDN edge that
 * does not forward the visitor's), and these budgets were counted per address:
 *
 *  - the password form's 5 per 15 minutes counted every sign-in, so the sixth
 *    customer of the quarter hour was refused for getting in;
 *  - the bot's magic link and the social sign-in flow shared that same counter,
 *    though a stale link or a tap on "Войти через Google" guesses nothing;
 *  - finishing a social sign-up shared it too.
 *
 * What is limited now is what is a guess: a wrong password, an invalid link
 * token. A sign-in that succeeds is given back. The flows with nothing to guess
 * have flood caps of their own, high on purpose, and the one that needs a
 * session is metered by the account.
 */
import cookieParser from 'cookie-parser';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';

import { createRedisRateLimiter, RATE_LIMITS } from '../../src/api/middleware/rate-limit.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import type { AdminClient } from '../../src/lib/admin-client.js';
import type { ReiwaConfig } from '../../src/config.js';
import type { WebSessionStore } from '../../src/infrastructure/redis/session.js';
import { sendSocketless } from './socketless-request.js';

/** The two scripts the limiter runs, applied as Redis would, to counters that never expire in a test. */
class FakeRedis {
  public readonly counters = new Map<string, number>();
  public readonly charged: string[] = [];

  public async get(): Promise<null> {
    return null;
  }

  public async eval(script: string, _keys: number, key: string): Promise<[number, number] | number> {
    if (script.includes('DECR')) {
      const count = this.counters.get(key) ?? 0;
      if (count <= 0) return 0;
      this.counters.set(key, count - 1);
      return count - 1;
    }
    this.charged.push(key);
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return [count, 900];
  }

  public async set(): Promise<'OK'> {
    return 'OK';
  }
}

interface Outcome {
  readonly status: number;
  readonly reachedHandler: boolean;
}

/** One request through a real limiter, answered with `respondWith` if it gets that far. */
async function through(
  limiter: ReturnType<typeof createRedisRateLimiter>,
  ip: string,
  respondWith: number,
): Promise<Outcome> {
  const finishListeners: Array<() => void> = [];
  let status = 200;
  const req = {
    ip,
    socket: { remoteAddress: ip },
    headers: {},
    method: 'POST',
    originalUrl: '',
    log: { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined },
  } as unknown as Request;
  const res = {
    get statusCode() {
      return status;
    },
    status(code: number) {
      status = code;
      return res;
    },
    setHeader: () => res,
    json: () => res,
    on(event: string, listener: () => void) {
      if (event === 'finish') finishListeners.push(listener);
      return res;
    },
  } as unknown as Response;
  let reachedHandler = false;
  const next: NextFunction = () => {
    reachedHandler = true;
  };
  await limiter(req, res, next);
  if (reachedHandler) {
    status = respondWith;
    for (const listener of finishListeners) listener();
  }
  // Refunds run on `finish` without being awaited; let them land.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { status, reachedHandler };
}

describe('the password form counts wrong passwords, not sign-ins', () => {
  it('lets a hundred customers sign in from one address', async () => {
    const redis = new FakeRedis();
    const limiter = createRedisRateLimiter(redis as unknown as Redis, 'login');

    const outcomes = [];
    for (let customer = 0; customer < 100; customer += 1) outcomes.push(await through(limiter, '198.51.100.7', 200));

    expect(outcomes.every((outcome) => outcome.reachedHandler)).toBe(true);
    expect(redis.counters.get(RATE_LIMITS.login.keyBuilder('198.51.100.7'))).toBe(0);
  });

  it('still blocks the sixth wrong password from the address', async () => {
    const redis = new FakeRedis();
    const limiter = createRedisRateLimiter(redis as unknown as Redis, 'login');

    const statuses = [];
    for (let guess = 0; guess < 8; guess += 1) statuses.push((await through(limiter, '198.51.100.8', 401)).status);

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
  });

  it('keeps counting wrong passwords between the sign-ins that succeed', async () => {
    const redis = new FakeRedis();
    const limiter = createRedisRateLimiter(redis as unknown as Redis, 'login');
    const results: Outcome[] = [];

    // Four typos, a hundred sign-ins, a fifth typo: all pass; the sixth typo does not.
    for (let typo = 0; typo < 4; typo += 1) results.push(await through(limiter, '198.51.100.9', 401));
    for (let customer = 0; customer < 100; customer += 1) results.push(await through(limiter, '198.51.100.9', 200));
    results.push(await through(limiter, '198.51.100.9', 401));
    const sixth = await through(limiter, '198.51.100.9', 401);

    expect(results.every((outcome) => outcome.reachedHandler)).toBe(true);
    expect(sixth.reachedHandler).toBe(false);
    expect(sixth.status).toBe(429);
  });

  it('does not let one address spend another\'s budget', async () => {
    const redis = new FakeRedis();
    const limiter = createRedisRateLimiter(redis as unknown as Redis, 'login');
    for (let guess = 0; guess < 8; guess += 1) await through(limiter, '198.51.100.10', 401);

    expect((await through(limiter, '198.51.100.11', 401)).reachedHandler).toBe(true);
  });
});

describe('the bot link and the social flow have budgets of their own', () => {
  it('gives each its own counter, apart from the password form and from each other', () => {
    const address = '198.51.100.20';
    const keys = [
      RATE_LIMITS.login.keyBuilder(address),
      RATE_LIMITS.botSignin.keyBuilder(address),
      RATE_LIMITS.oauth.keyBuilder(address),
    ];

    expect(new Set(keys).size).toBe(3);
  });

  it('counts failed links only, and tolerates the stale links customers produce', async () => {
    const redis = new FakeRedis();
    const limiter = createRedisRateLimiter(redis as unknown as Redis, 'botSignin');

    // A day's worth of customers opening the magic link: all sign in.
    for (let customer = 0; customer < 200; customer += 1) {
      expect((await through(limiter, '198.51.100.21', 200)).reachedHandler).toBe(true);
    }
    // Thirty expired or used links pass to be answered; the thirty-first is refused.
    for (let stale = 0; stale < RATE_LIMITS.botSignin.maxAttempts; stale += 1) {
      expect((await through(limiter, '198.51.100.21', 401)).reachedHandler).toBe(true);
    }
    expect((await through(limiter, '198.51.100.21', 401)).reachedHandler).toBe(false);
  });

  it('caps the social flow high instead of at five', async () => {
    const redis = new FakeRedis();
    const limiter = createRedisRateLimiter(redis as unknown as Redis, 'oauth');

    // Starts and callbacks are redirects (302): nothing is given back, and 120 pass.
    for (let tap = 0; tap < RATE_LIMITS.oauth.maxAttempts; tap += 1) {
      expect((await through(limiter, '198.51.100.22', 302)).reachedHandler).toBe(true);
    }
    expect((await through(limiter, '198.51.100.22', 302)).reachedHandler).toBe(false);
    expect(RATE_LIMITS.oauth.maxAttempts).toBeGreaterThan(RATE_LIMITS.login.maxAttempts * 10);
  });
});

describe('the wiring: which counter each route is charged to', () => {
  function buildApp() {
    const redis = new FakeRedis();
    const extAuth = { finishSetup: vi.fn(async () => ({ ok: true as const })), authorizeUrl: vi.fn(async () => ({ url: 'https://provider.example/auth' })) };
    const webAuth = {
      login: vi.fn(async () => {
        throw new Error('wrong password');
      }),
      consumeBotSigninToken: vi.fn(async () => ({ userId: null })),
      sendFirstPasswordLink: vi.fn(async () => ({ status: 'not_applicable' as const })),
    };
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, _res, next) => {
      req.createWebSession = vi.fn(async () => 'session-1');
      req.destroyWebSession = vi.fn(async () => undefined);
      const user = req.headers['x-test-user'];
      if (typeof user === 'string') {
        req.webSession = { userId: user, createdAt: Date.now(), ip: '127.0.0.1', lastActivity: Date.now() };
        req.webSessionId = `session-of-${user}`;
      }
      next();
    });
    app.use(
      '/api/v1',
      createAuthRouter({
        adminClient: { webAuth, extAuth } as unknown as AdminClient,
        sessionStore: null,
        webSessionStore: { getRedis: () => redis } as unknown as WebSessionStore,
        config: { NODE_ENV: 'test', REIWA_DOMAIN: 'cabinet.example.com' } as unknown as ReiwaConfig,
      }),
    );
    return { app, redis, extAuth };
  }

  const ADDRESS = '198.51.100.30';

  it('charges the bot link to its own counter', async () => {
    const { app, redis } = buildApp();
    await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/auth/bot-signin',
      body: { token: 'a'.repeat(64) },
      headers: { 'x-forwarded-for': ADDRESS },
    });

    expect(redis.charged).toEqual([`rate:botsignin:${ADDRESS}`]);
  });

  it('charges the social flow to its own counter', async () => {
    const { app, redis } = buildApp();
    await sendSocketless(app, {
      method: 'GET',
      url: '/api/v1/auth/ext/google/start',
      headers: { 'x-forwarded-for': ADDRESS },
    });

    expect(redis.charged).toEqual([`rate:oauth:${ADDRESS}`]);
  });

  it('charges the password form to the password counter', async () => {
    const { app, redis } = buildApp();
    await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { username: 'alice', passwordHash: 'd'.repeat(64) },
      headers: { 'x-forwarded-for': ADDRESS },
    });

    expect(redis.charged).toEqual([`rate:login:${ADDRESS}`]);
  });

  it('meters finishing a social sign-up by the account, not by the address, and charges Redis nothing', async () => {
    const { app, redis, extAuth } = buildApp();
    const finish = (user: string) =>
      sendSocketless(app, {
        method: 'POST',
        url: '/api/v1/auth/ext/finish-setup',
        body: { username: 'new-login', passwordHash: 'd'.repeat(64) },
        headers: { 'x-forwarded-for': ADDRESS, 'x-test-user': user },
      });

    // Fifty different customers behind one address, one finish each.
    const statuses = [];
    for (let customer = 1; customer <= 50; customer += 1) statuses.push((await finish(`user-${customer}`)).status);
    expect(statuses.filter((status) => status !== 200)).toEqual([]);

    // One account hammering it is bounded.
    const same = [];
    for (let attempt = 1; attempt <= 25; attempt += 1) same.push((await finish('user-1')).status);
    expect(same.filter((status) => status === 429).length).toBeGreaterThan(0);

    expect(redis.charged).toEqual([]);
    expect(extAuth.finishSetup).toHaveBeenCalled();
  });

  it('answers 401 to a finish with no session and meters nothing for it', async () => {
    const { app, redis } = buildApp();
    const statuses = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      statuses.push(
        (
          await sendSocketless(app, {
            method: 'POST',
            url: '/api/v1/auth/ext/finish-setup',
            body: { username: 'new-login', passwordHash: 'd'.repeat(64) },
            headers: { 'x-forwarded-for': ADDRESS },
          })
        ).status,
      );
    }

    expect(new Set(statuses)).toEqual(new Set([401]));
    expect(redis.charged).toEqual([]);
  });
});
