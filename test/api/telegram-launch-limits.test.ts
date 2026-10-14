/**
 * The Mini App's sign-in routes are metered by what a launch proves, not by
 * the address it came from.
 *
 * The incident: a customer was shown "Слишком много попыток. Попробуйте снова
 * через 527 сек." on the Mini App's start screen. One in-memory budget of 20 per
 * 15 minutes per address covered every cold start of the app AND "I already
 * have an account", and an operator's customers share addresses (a carrier NAT,
 * a VPN exit, a CDN edge that does not forward the visitor's address), so the
 * twenty-first customer in a quarter of an hour was refused with a valid launch.
 *
 * Three promises, each held below:
 *  - a launch signed by Telegram is never refused because other customers share
 *    the address, however many of them there are;
 *  - garbage from one address is still limited, and does not spend anybody
 *    else's budget;
 *  - the key a signed launch is metered by cannot be set by an attacker: nothing
 *    unsigned is ever one, so nobody can use up a victim's allowance.
 *
 * The limiter is exercised as the middleware it is, over request and response
 * doubles whose `finish` the test fires - the refund of a successful sign-in
 * happens there, and a socket-free harness never reaches it.
 */
import { createHmac } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import cookieParser from 'cookie-parser';
import { describe, expect, it, vi } from 'vitest';

import { apiLimiter } from '../../src/api/middleware/rate-limit.js';
import {
  createTelegramLaunchLimiter,
  FixedWindowCounter,
  TELEGRAM_LAUNCH_LIMITS,
} from '../../src/api/middleware/telegram-launch-limits.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import type { AdminClient } from '../../src/lib/admin-client.js';
import type { ReiwaConfig } from '../../src/config.js';
import type { WebSessionStore } from '../../src/infrastructure/redis/session.js';
import { sendSocketless } from './socketless-request.js';

const BOT_TOKEN = '123456:TEST-bot-token';
const MINUTE = 60_000;

/** A launch payload signed the way Telegram signs it. */
function signedLaunch(
  telegramId: number,
  options: { readonly authDate?: number; readonly botToken?: string } = {},
): string {
  const fields: Record<string, string> = {
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: `AAH${telegramId}`,
    user: JSON.stringify({ id: telegramId, first_name: `User${telegramId}` }),
  };
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(options.botToken ?? BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** A payload that CLAIMS `telegramId` and carries a hash that is not the signature. */
function forgedLaunch(telegramId: number): string {
  return new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: telegramId, first_name: 'Forged' }),
    hash: 'f'.repeat(64),
  }).toString();
}

interface Outcome {
  /** The limiter let the request through to the route's handler. */
  readonly reachedHandler: boolean;
  /** 429 from the limiter, else the status the pretend handler answered with. */
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | undefined;
}

interface Harness {
  readonly send: (input: {
    readonly ip: string;
    readonly authorization?: string;
    /** What the route's handler answers once the limiter lets the request in. */
    readonly handlerStatus?: number;
  }) => Promise<Outcome>;
  readonly warnings: Array<Record<string, unknown>>;
}

function harness(
  kind: 'bootstrap' | 'link-existing',
  options: {
    readonly now?: () => number;
    readonly botToken?: string | undefined;
    readonly limits?: Parameters<typeof createTelegramLaunchLimiter>[0]['limits'];
  } = {},
): Harness {
  const warnings: Array<Record<string, unknown>> = [];
  const limiter = createTelegramLaunchLimiter({
    kind,
    botToken: 'botToken' in options ? options.botToken : BOT_TOKEN,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  });
  return {
    warnings,
    send: async (input) => {
      const finishListeners: Array<() => void> = [];
      const captured: { status: number; body: unknown; headers: Record<string, string> } = {
        status: 200,
        body: undefined,
        headers: {},
      };
      const req = {
        ip: input.ip,
        socket: { remoteAddress: input.ip },
        headers: input.authorization === undefined ? {} : { authorization: input.authorization },
        method: 'POST',
        originalUrl: `/api/v1/auth/telegram/${kind === 'bootstrap' ? 'bootstrap' : 'link-existing'}`,
        log: {
          warn: (context: Record<string, unknown>) => warnings.push(context),
          info: () => undefined,
          error: () => undefined,
          debug: () => undefined,
          child: () => req.log,
        },
      } as unknown as Request;
      const res = {
        get statusCode() {
          return captured.status;
        },
        status(code: number) {
          captured.status = code;
          return res;
        },
        setHeader(name: string, value: string) {
          captured.headers[name.toLowerCase()] = value;
          return res;
        },
        json(body: unknown) {
          captured.body = body;
          return res;
        },
        on(event: string, listener: () => void) {
          if (event === 'finish') finishListeners.push(listener);
          return res;
        },
      } as unknown as Response;

      let reachedHandler = false;
      const next: NextFunction = () => {
        reachedHandler = true;
      };
      limiter(req, res, next);
      if (reachedHandler) {
        captured.status = input.handlerStatus ?? 200;
        for (const listener of finishListeners) listener();
      }
      return {
        reachedHandler,
        status: captured.status,
        body: captured.body,
        retryAfter: captured.headers['retry-after'],
      };
    },
  };
}

describe('POST /auth/telegram/bootstrap - a signed launch is never refused for who else is on the address', () => {
  it('lets a thousand different customers launch from one address', async () => {
    const { send } = harness('bootstrap');
    // A carrier NAT, a VPN exit or a CDN edge: ONE address, everybody behind it.
    const outcomes = [];
    for (let customer = 1; customer <= 1000; customer += 1) {
      outcomes.push(await send({ ip: '198.51.100.7', authorization: `tma ${signedLaunch(1_000_000 + customer)}` }));
    }

    expect(outcomes.filter((outcome) => outcome.status === 429)).toEqual([]);
    expect(outcomes.every((outcome) => outcome.reachedHandler)).toBe(true);
  });

  it('has no per-address budget of every request left on these two routes', async () => {
    // The old `authLimiter` counted every request per address; it is gone, and the
    // sign-in routes do not name it.
    const limits = await import('../../src/api/middleware/rate-limit.js');
    expect('authLimiter' in limits).toBe(false);
  });

  it('lets one customer open the app again and again, up to a generous bound', async () => {
    const { send } = harness('bootstrap');
    const launch = `tma ${signedLaunch(42)}`;

    for (let start = 1; start <= TELEGRAM_LAUNCH_LIMITS.launchesPerUser; start += 1) {
      expect((await send({ ip: '203.0.113.5', authorization: launch })).status).toBe(200);
    }
    const refused = await send({ ip: '203.0.113.5', authorization: launch });

    expect(refused.status).toBe(429);
    expect(refused.reachedHandler).toBe(false);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    expect(refused.body).toMatchObject({ retryAfter: Number(refused.retryAfter) });
    // Another customer on the same address is untouched by it.
    expect((await send({ ip: '203.0.113.5', authorization: `tma ${signedLaunch(43)}` })).status).toBe(200);
  });

  it('forgives the customer when the window passes', async () => {
    let at = 1_000_000;
    const { send } = harness('bootstrap', { now: () => at });
    const launch = `tma ${signedLaunch(42)}`;
    for (let start = 0; start <= TELEGRAM_LAUNCH_LIMITS.launchesPerUser; start += 1) {
      await send({ ip: '203.0.113.5', authorization: launch });
    }
    expect((await send({ ip: '203.0.113.5', authorization: launch })).status).toBe(429);

    at += 15 * MINUTE + 1;

    expect((await send({ ip: '203.0.113.5', authorization: launch })).status).toBe(200);
  });
});

describe('POST /auth/telegram/bootstrap - garbage from one address is still limited', () => {
  it('lets 20 bad launches reach the route (which answers 401), then answers 429', async () => {
    const { send } = harness('bootstrap');
    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      statuses.push(
        (await send({ ip: '192.0.2.99', authorization: `tma ${forgedLaunch(7)}`, handlerStatus: 401 })).status,
      );
    }

    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(401));
    expect(statuses.slice(20)).toEqual(Array(5).fill(429));
  });

  it('counts a missing header, an empty one, junk, an oversize one and a launch signed with another bot token', async () => {
    const { send } = harness('bootstrap', { limits: { invalidPerAddress: 4 } });
    const bad = [
      undefined,
      '',
      'tma ',
      'tma not-a-launch',
      `tma ${'a'.repeat(20_000)}`,
      `tma ${signedLaunch(5, { botToken: '999:another-bot' })}`,
    ];

    const results = [];
    for (const authorization of bad) results.push(await send({ ip: '192.0.2.50', authorization, handlerStatus: 401 }));

    expect(results.map((result) => result.status)).toEqual([401, 401, 401, 401, 429, 429]);
  });

  it('counts a launch past the 24 hours Telegram signs for', async () => {
    const { send } = harness('bootstrap', { limits: { invalidPerAddress: 1 } });
    const stale = `tma ${signedLaunch(5, { authDate: Math.floor(Date.now() / 1000) - 25 * 3600 })}`;

    expect((await send({ ip: '192.0.2.51', authorization: stale, handlerStatus: 401 })).status).toBe(401);
    expect((await send({ ip: '192.0.2.51', authorization: stale, handlerStatus: 401 })).status).toBe(429);
  });

  it('never refuses a signed launch from an address that is over its bad-launch budget', async () => {
    const { send } = harness('bootstrap', { limits: { invalidPerAddress: 3 } });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await send({ ip: '192.0.2.60', authorization: `tma ${forgedLaunch(9)}`, handlerStatus: 401 });
    }
    expect((await send({ ip: '192.0.2.60', authorization: `tma ${forgedLaunch(9)}`, handlerStatus: 401 })).status).toBe(429);

    // The same address, a real customer: through.
    const customer = await send({ ip: '192.0.2.60', authorization: `tma ${signedLaunch(1234)}` });
    expect(customer.reachedHandler).toBe(true);
    expect(customer.status).toBe(200);
  });

  it('keeps the bad-launch count of one address from touching another', async () => {
    const { send } = harness('bootstrap', { limits: { invalidPerAddress: 2 } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await send({ ip: '192.0.2.61', authorization: 'tma junk', handlerStatus: 401 });
    }

    expect((await send({ ip: '192.0.2.62', authorization: 'tma junk', handlerStatus: 401 })).status).toBe(401);
  });

  it('counts an IPv6 visitor by its /64, as the other address budgets do', async () => {
    const { send } = harness('bootstrap', { limits: { invalidPerAddress: 2 } });
    for (const suffix of ['1', '2', '3']) {
      await send({ ip: `2001:db8:1:2::${suffix}`, authorization: 'tma junk', handlerStatus: 401 });
    }

    expect((await send({ ip: '2001:db8:1:2:ffff::9', authorization: 'tma junk', handlerStatus: 401 })).status).toBe(429);
  });

  it('bounds a script that holds many real Telegram accounts with a high per-address cap', async () => {
    const { send } = harness('bootstrap', { limits: { launchesPerAddress: 50 } });
    const statuses: number[] = [];
    for (let account = 1; account <= 55; account += 1) {
      statuses.push((await send({ ip: '192.0.2.70', authorization: `tma ${signedLaunch(5_000 + account)}` })).status);
    }

    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    expect(TELEGRAM_LAUNCH_LIMITS.launchesPerAddress).toBeGreaterThanOrEqual(1000);
  });
});

describe('the key a launch is metered by cannot be set by an attacker', () => {
  it('does not let forged payloads claiming a victim spend the victim allowance', async () => {
    const victim = 777_001;
    const { send } = harness('bootstrap');

    // An attacker hammers the route with payloads that NAME the victim and carry
    // no valid signature. Metered by the id in the body, the victim would be out
    // of launches after 60 of these.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await send({ ip: '192.0.2.80', authorization: `tma ${forgedLaunch(victim)}`, handlerStatus: 401 });
    }

    // The victim, from anywhere, with their real launch: through - and with the
    // whole allowance still there.
    for (let start = 1; start <= TELEGRAM_LAUNCH_LIMITS.launchesPerUser; start += 1) {
      const outcome = await send({ ip: '203.0.113.90', authorization: `tma ${signedLaunch(victim)}` });
      expect(outcome.status, `launch ${start}`).toBe(200);
    }
  });

  it('keys a launch by the id INSIDE the verified payload, not by anything else the request says', async () => {
    const { send } = harness('bootstrap', { limits: { launchesPerUser: 2 } });
    const launch = `tma ${signedLaunch(31)}`;
    // Different addresses and headers, one signer: one allowance.
    const statuses = [
      (await send({ ip: '203.0.113.1', authorization: launch })).status,
      (await send({ ip: '203.0.113.2', authorization: launch })).status,
      (await send({ ip: '203.0.113.3', authorization: launch })).status,
    ];

    expect(statuses).toEqual([200, 200, 429]);
  });

  it('writes neither the payload nor its hash into the log when it refuses', async () => {
    const { send, warnings } = harness('bootstrap', { limits: { invalidPerAddress: 1 } });
    const forged = forgedLaunch(11);
    await send({ ip: '192.0.2.81', authorization: `tma ${forged}`, handlerStatus: 401 });
    await send({ ip: '192.0.2.81', authorization: `tma ${forged}`, handlerStatus: 401 });

    expect(warnings).toHaveLength(1);
    const logged = JSON.stringify(warnings);
    expect(logged).toContain('invalid-launch');
    expect(logged).not.toContain(forged);
    expect(logged).not.toContain('f'.repeat(64));
  });
});

describe('the limiter stays out of the way when it has nothing to verify with', () => {
  it('passes everything through without a bot token, for the route to answer for itself', async () => {
    for (const botToken of [undefined, '']) {
      const { send } = harness('bootstrap', { botToken, limits: { invalidPerAddress: 1 } });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await send({ ip: '192.0.2.90' })).reachedHandler).toBe(true);
      }
    }
  });
});

describe('POST /auth/telegram/link-existing - a password is being tried, so a wrong one is what counts', () => {
  it('refuses the eleventh wrong password from one Telegram account before the password is looked at', async () => {
    const { send } = harness('link-existing');
    const launch = `tma ${signedLaunch(88)}`;
    const results = [];
    for (let guess = 1; guess <= 12; guess += 1) {
      results.push(await send({ ip: '203.0.113.20', authorization: launch, handlerStatus: 401 }));
    }

    expect(results.slice(0, 10).map((result) => result.reachedHandler)).toEqual(Array(10).fill(true));
    expect(results.slice(10).map((result) => result.status)).toEqual([429, 429]);
    expect(results.slice(10).some((result) => result.reachedHandler)).toBe(false);
  });

  it('counts a body with junk in it as a failed attempt too', async () => {
    const { send } = harness('link-existing', { limits: { failuresPerUser: 2 } });
    const launch = `tma ${signedLaunch(89)}`;

    await send({ ip: '203.0.113.21', authorization: launch, handlerStatus: 400 });
    await send({ ip: '203.0.113.21', authorization: launch, handlerStatus: 400 });

    expect((await send({ ip: '203.0.113.21', authorization: launch })).status).toBe(429);
  });

  it('does not count a link that worked, nor a refusal that needed the right password', async () => {
    const { send } = harness('link-existing', { limits: { failuresPerUser: 2, failuresPerAddress: 2 } });
    const launch = `tma ${signedLaunch(90)}`;

    // Linked (200), already linked (200), "needs an admin merge" / "has another
    // Telegram" (409: the credentials were right), an outage (500, 503).
    for (const handlerStatus of [200, 200, 409, 409, 500, 503, 200, 409]) {
      const outcome = await send({ ip: '203.0.113.22', authorization: launch, handlerStatus });
      expect(outcome.reachedHandler, `status ${handlerStatus}`).toBe(true);
    }
    expect((await send({ ip: '203.0.113.22', authorization: launch, handlerStatus: 200 })).status).toBe(200);
  });

  it('lets one wrong password through to a customer on an address where others have been wrong', async () => {
    const { send } = harness('link-existing', { limits: { failuresPerAddress: 30 } });
    // 29 failures from 29 different Telegram accounts on one address ...
    for (let account = 1; account <= 29; account += 1) {
      await send({ ip: '203.0.113.23', authorization: `tma ${signedLaunch(2_000 + account)}`, handlerStatus: 401 });
    }

    // ... the 30th still reaches the route; the 31st does not.
    expect((await send({ ip: '203.0.113.23', authorization: `tma ${signedLaunch(2_100)}`, handlerStatus: 401 })).reachedHandler).toBe(true);
    expect((await send({ ip: '203.0.113.23', authorization: `tma ${signedLaunch(2_101)}`, handlerStatus: 401 })).status).toBe(429);
  });

  it('keeps its counters apart from the bootstrap route', async () => {
    const bootstrap = harness('bootstrap', { limits: { launchesPerUser: 1 } });
    const linking = harness('link-existing', { limits: { failuresPerUser: 1 } });
    const launch = `tma ${signedLaunch(91)}`;

    await linking.send({ ip: '203.0.113.24', authorization: launch, handlerStatus: 401 });
    expect((await linking.send({ ip: '203.0.113.24', authorization: launch })).status).toBe(429);

    expect((await bootstrap.send({ ip: '203.0.113.24', authorization: launch })).status).toBe(200);
  });

  it('never counts a forged payload against the Telegram account it names', async () => {
    const { send } = harness('link-existing', { limits: { failuresPerUser: 1 } });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await send({ ip: '192.0.2.95', authorization: `tma ${forgedLaunch(92)}`, handlerStatus: 401 });
    }

    const owner = await send({ ip: '203.0.113.25', authorization: `tma ${signedLaunch(92)}`, handlerStatus: 401 });
    expect(owner.reachedHandler).toBe(true);
  });

  it('shares a bad-launch strike count by address with nothing but its own route', async () => {
    const bootstrap = harness('bootstrap', { limits: { invalidPerAddress: 1 } });
    const linking = harness('link-existing', { limits: { invalidPerAddress: 1 } });
    await linking.send({ ip: '192.0.2.96', authorization: 'tma junk', handlerStatus: 401 });
    await linking.send({ ip: '192.0.2.96', authorization: 'tma junk', handlerStatus: 401 });

    expect((await bootstrap.send({ ip: '192.0.2.96', authorization: 'tma junk', handlerStatus: 401 })).status).toBe(401);
  });
});

describe('FixedWindowCounter', () => {
  it('counts within a window, starts over after it, and gives one back without moving the window', () => {
    let at = 0;
    const counter = new FixedWindowCounter(1000, () => at);

    expect(counter.hit('k').count).toBe(1);
    at = 400;
    const second = counter.hit('k');
    expect(second.count).toBe(2);
    counter.refund('k');
    expect(counter.peek('k')).toBe(1);
    expect(counter.retryAfterSeconds(second)).toBe(1);

    at = 1001;
    expect(counter.peek('k')).toBe(0);
    expect(counter.hit('k').count).toBe(1);
  });

  it('never refunds below zero or into a window that has passed', () => {
    let at = 0;
    const counter = new FixedWindowCounter(1000, () => at);
    counter.refund('absent');
    counter.hit('k');
    counter.refund('k');
    counter.refund('k');
    expect(counter.peek('k')).toBe(0);

    counter.hit('k');
    at = 5000;
    counter.refund('k');
    expect(counter.hit('k').count).toBe(1);
  });
});

describe('the wiring: the real auth router and the /api budget', () => {
  function buildRealApp() {
    const bootstrap = vi.fn(async () => ({ id: 'user-1' }));
    const createWebSession = vi.fn(async () => 'session-1');
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, _res, next) => {
      req.createWebSession = createWebSession;
      req.destroyWebSession = vi.fn(async () => undefined);
      next();
    });
    app.use('/api', apiLimiter);
    app.use(
      '/api/v1',
      createAuthRouter({
        adminClient: {
          user: { bootstrap },
          webAuth: {
            issueBotSigninToken: async () => ({ token: 'a'.repeat(64) }),
            consumeBotSigninToken: async () => ({ userId: 'user-1' }),
          },
        } as unknown as AdminClient,
        sessionStore: null,
        webSessionStore: { getRedis: () => null } as unknown as WebSessionStore,
        config: { NODE_ENV: 'test', BOT_TOKEN } as unknown as ReiwaConfig,
      }),
    );
    return { app, bootstrap, createWebSession };
  }

  it('signs 150 different customers in from one address - past the 120 a minute /api allows and the 20 it used to', async () => {
    const { app, createWebSession } = buildRealApp();
    const statuses: number[] = [];
    for (let customer = 1; customer <= 150; customer += 1) {
      const response = await sendSocketless(app, {
        method: 'POST',
        url: '/api/v1/auth/telegram/bootstrap',
        headers: { 'x-forwarded-for': '198.51.100.200', authorization: `tma ${signedLaunch(9_000 + customer)}` },
      });
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status !== 200)).toEqual([]);
    expect(createWebSession).toHaveBeenCalledTimes(150);
  });

  it('answers a flood of bad launches from one address with 401 and then 429, as the Mini App countdown expects', async () => {
    const { app, bootstrap } = buildRealApp();
    const responses = [];
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      responses.push(
        await sendSocketless(app, {
          method: 'POST',
          url: '/api/v1/auth/telegram/bootstrap',
          headers: { 'x-forwarded-for': '198.51.100.201', authorization: `tma ${forgedLaunch(5)}` },
        }),
      );
    }

    expect(responses.slice(0, 20).map((response) => response.status)).toEqual(Array(20).fill(401));
    const refused = responses[20];
    expect(refused?.status).toBe(429);
    expect(refused?.body).toMatchObject({ message: expect.any(String), retryAfter: expect.any(Number) });
    expect(refused?.headers['retry-after']).toBeDefined();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('still counts every other route against the /api budget', async () => {
    const { app } = buildRealApp();
    let refused = 0;
    for (let call = 1; call <= 130; call += 1) {
      const response = await sendSocketless(app, {
        method: 'POST',
        url: '/api/v1/auth/check-username',
        body: { username: 'someone' },
        headers: { 'x-forwarded-for': '198.51.100.202' },
      });
      if (response.status === 429) refused += 1;
    }

    expect(refused).toBeGreaterThan(0);
  });
});
