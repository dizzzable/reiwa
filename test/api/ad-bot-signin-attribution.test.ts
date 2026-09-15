/**
 * Advertising attribution on `POST /api/v1/auth/bot-signin` — the magic link
 * the bot puts on its cabinet button.
 *
 * A visitor who clicks a web ad gets its code parked in the `ad_code` cookie
 * (`middleware/ad-capture.ts`). If they then go on to the bot, the bot creates
 * the account, and the browser comes back through this route — which used to
 * mint the session and never claim the code, so the funnel showed an open and no
 * registration. The owner's decision (14.09.2026): attribute it, through the
 * same helper `/auth/register` and the social callback use.
 *
 * What must hold, beside the attribution itself, is that the sign-in does not
 * change: same status, same body, whether attribution worked, failed, hung, or
 * had nothing to do. And a link that signs nobody in attributes nobody.
 *
 * The newness of the account is not checked here and not tested here: rezeis
 * refuses to attribute an account older than a day (`isNewAccountAtTouch` in
 * rezeis-admin's `ad-attribution.service.ts`), so a long-standing customer
 * signing in with a parked code acquires nothing.
 *
 * Socket-free for the reason `socketless-request.ts` gives.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminClient } from '../../src/lib/admin-client.js';
import type { ReiwaConfig } from '../../src/config.js';
import type { WebSessionStore } from '../../src/infrastructure/redis/session.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { sendSocketless, type SocketlessResponse } from './socketless-request.js';

const LIVE_TOKEN = 'a'.repeat(64);
const SPENT_TOKEN = 'b'.repeat(64);
const AD_COOKIE = 'ad_code=WIcpYLNTs5';
const SIGNED_IN = { success: true, redirectUrl: '/dashboard' };

function buildApp(options: {
  readonly recordClick?: () => Promise<unknown>;
  readonly createWebSession?: () => Promise<string>;
} = {}) {
  const recordClick = vi.fn(async (_input: Record<string, unknown>) =>
    options.recordClick === undefined ? { ok: true } : options.recordClick(),
  );
  const consumeBotSigninToken = vi.fn(async (token: string) => ({
    userId: token === LIVE_TOKEN ? 'user-from-bot' : null,
  }));
  const createWebSession = vi.fn(options.createWebSession ?? (async () => 'session-1'));

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.createWebSession = createWebSession;
    next();
  });
  app.use(
    '/api/v1',
    createAuthRouter({
      adminClient: { webAuth: { consumeBotSigninToken }, advertising: { recordClick } } as unknown as AdminClient,
      sessionStore: null,
      // Lets the login rate limiter through: one hit in a 60 s window.
      webSessionStore: {
        getRedis: () => ({ get: async () => null, eval: async () => [1, 60] }),
      } as unknown as WebSessionStore,
      config: { NODE_ENV: 'test' } as unknown as ReiwaConfig,
    }),
  );
  return { app, recordClick, consumeBotSigninToken, createWebSession };
}

function signIn(app: express.Express, token: string, cookie?: string): Promise<SocketlessResponse> {
  return sendSocketless(app, {
    method: 'POST',
    url: '/api/v1/auth/bot-signin',
    headers: cookie === undefined ? {} : { cookie },
    body: { token },
  });
}

function setCookies(response: SocketlessResponse): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
}

function adCookieExpiry(response: SocketlessResponse): string | undefined {
  return setCookies(response).find((line) => line.startsWith('ad_code='));
}

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

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /auth/bot-signin — advertising attribution', () => {
  it('binds the account the bot created to the parked ad code, then expires the cookie', async () => {
    const { app, recordClick, createWebSession } = buildApp();

    const response = await signIn(app, LIVE_TOKEN, AD_COOKIE);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(SIGNED_IN);
    expect(createWebSession).toHaveBeenCalledWith('user-from-bot');
    // attributeOnly: the open was counted when the browser landed on the ad.
    expect(recordClick.mock.calls).toEqual([
      [{ code: 'WIcpYLNTs5', userId: 'user-from-bot', surface: 'WEB', isNewUser: true, attributeOnly: true }],
    ]);
    const expiry = adCookieExpiry(response);
    expect(expiry, 'a confirmed attribution must expire the cookie on this very response').toBeDefined();
    expect(expiry).toMatch(/^ad_code=;/);
  });

  it('does not call attribution when the browser carries no ad code', async () => {
    const { app, recordClick } = buildApp();

    const response = await signIn(app, LIVE_TOKEN);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(SIGNED_IN);
    expect(recordClick).not.toHaveBeenCalled();
    expect(adCookieExpiry(response)).toBeUndefined();
  });

  it('signs in all the same when rezeis refuses the attribution, and keeps the code for a retry', async () => {
    const { app, recordClick } = buildApp({
      recordClick: async () => {
        throw new Error('Request failed with status code 400');
      },
    });

    const response = await signIn(app, LIVE_TOKEN, AD_COOKIE);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(SIGNED_IN);
    expect(recordClick).toHaveBeenCalledTimes(1);
    expect(adCookieExpiry(response)).toBeUndefined();
  });

  it('waits exactly 2 s for a rezeis that never answers, then signs in all the same with the code kept', async () => {
    // Only the timers: the turns `settles` waits on stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let asked: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    const { app, recordClick } = buildApp({
      recordClick: () => {
        asked();
        return new Promise<unknown>(() => undefined);
      },
    });

    const pending = signIn(app, LIVE_TOKEN, AD_COOKIE);
    // The attribution deadline is armed in the same turn rezeis is asked.
    await reached;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(await settles(pending), 'answered before the attribution deadline').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settles(pending), 'still waiting at 2 s').toBe(true);

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toEqual(SIGNED_IN);
    expect(recordClick).toHaveBeenCalledTimes(1);
    expect(adCookieExpiry(response)).toBeUndefined();
  });

  it('attributes nobody for a malformed token or one that is unknown, expired or spent', async () => {
    const { app, recordClick, consumeBotSigninToken, createWebSession } = buildApp();

    const malformed = await signIn(app, 'not-a-token', AD_COOKIE);
    expect(malformed).toMatchObject({ status: 401, body: { success: false, message: 'Invalid or expired link' } });

    const spent = await signIn(app, SPENT_TOKEN, AD_COOKIE);
    expect(spent).toMatchObject({ status: 401, body: { success: false, message: 'Invalid or expired link' } });
    expect(consumeBotSigninToken).toHaveBeenCalledTimes(1);

    expect(createWebSession).not.toHaveBeenCalled();
    expect(recordClick).not.toHaveBeenCalled();
    expect(adCookieExpiry(malformed)).toBeUndefined();
    expect(adCookieExpiry(spent)).toBeUndefined();
  });

  it('attributes nobody when the session could not be created', async () => {
    const { app, recordClick } = buildApp({
      createWebSession: async () => {
        throw new Error('Redis connection lost');
      },
    });

    const response = await signIn(app, LIVE_TOKEN, AD_COOKIE);

    expect(response).toMatchObject({ status: 500, body: { success: false, message: 'Failed to create session' } });
    expect(recordClick).not.toHaveBeenCalled();
    expect(adCookieExpiry(response)).toBeUndefined();
  });
});
