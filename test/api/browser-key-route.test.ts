/**
 * `POST /api/v1/auth/browser-key` — a one-time key to open the cabinet in the
 * phone's own browser, signed in. Asked by the Mini App's `/open-in-browser`.
 *
 * The key is the bot's own `bot-signin`, spent by `/auth/bot-signin` like every
 * other; this route only decides WHO may ask. Each case is one way that could
 * go wrong: a caller with no session, a session asking for somebody else's
 * account, a website account with no Telegram behind it, a panel that could not
 * issue — a key left behind in a cache — and a session that is another Telegram
 * account's than the one whose tap asked (one app, several accounts, ONE cookie
 * store), which must be refused on launch data verified with the bot token.
 */
import { createHmac } from 'node:crypto';

import express from 'express';
import cookieParser from 'cookie-parser';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserKeyRouter } from '../../src/api/routes/browser-key.js';
import { sendSocketless, type SocketlessResponse } from './socketless-request.js';

const ACCOUNT = 'cm0account000000000000001';
const KEY = 'e5'.repeat(32);
const BOT_TOKEN = '123456:TEST-bot-token-for-launch-data';

/** Launch data as Telegram signs it: HMAC-SHA256 keyed by HMAC("WebAppData", bot token). */
function signedLaunchData(
  userId: number,
  options: { readonly token?: string; readonly authDate?: number } = {},
): string {
  const fields: Record<string, string> = {
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: 'AAE-test',
    user: JSON.stringify({ id: userId, first_name: 'Anna' }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(options.token ?? BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

interface Options {
  /** The signed-in account; absent for no session. */
  readonly account?: string;
  readonly telegramId?: string | null;
  readonly issue?: (telegramId: string) => Promise<{ token: string | null; expiresAt: string | null }>;
  readonly botToken?: string | null;
}

function harness(options: Options) {
  const getSession = vi.fn(async () => ({ id: ACCOUNT, telegramId: options.telegramId === undefined ? '4242' : options.telegramId }));
  const issueBotSigninToken = vi.fn(
    options.issue ?? (async (_telegramId: string) => ({ token: KEY, expiresAt: '2026-09-22T12:05:00.000Z' })),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = log;
    req.webSession =
      options.account === undefined
        ? null
        : { userId: options.account, createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    req.webSessionId = options.account === undefined ? null : `session-of-${options.account}`;
    next();
  });
  app.use(
    '/api/v1',
    createBrowserKeyRouter({
      adminClient: { user: { getSession }, webAuth: { issueBotSigninToken } } as never,
      sessionStore: { get: async () => null, refresh: async () => undefined } as never,
      config: { BOT_TOKEN: options.botToken === undefined ? BOT_TOKEN : options.botToken },
    }),
  );
  return { app, getSession, issueBotSigninToken, log };
}

/** The tap of Telegram user 4242 — the session's own account unless a case says otherwise. */
function ask(app: express.Express, initData: string | null = signedLaunchData(4242)): Promise<SocketlessResponse> {
  return sendSocketless(app, {
    method: 'POST',
    url: '/api/v1/auth/browser-key',
    body: {},
    ...(initData === null ? {} : { headers: { authorization: `tma ${initData}` } }),
  });
}

describe('who may ask for a key', () => {
  it('answers 401 to a caller with no session, and asks the panel nothing', async () => {
    const h = harness({});
    expect(await ask(h.app)).toMatchObject({ status: 401 });
    expect(h.issueBotSigninToken).not.toHaveBeenCalled();
  });

  it('issues a key for the session’s OWN Telegram account, and no other', async () => {
    const h = harness({ account: ACCOUNT, telegramId: '4242' });
    const res = await ask(h.app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: KEY, expiresAt: '2026-09-22T12:05:00.000Z' });
    // The Telegram id comes from the panel's answer about THIS session's account,
    // never from anything the caller sent.
    expect(h.getSession).toHaveBeenCalledWith({ userId: ACCOUNT });
    expect(h.issueBotSigninToken).toHaveBeenCalledWith('4242');
  })

  it('keeps the key out of every cache', async () => {
    const res = await ask(harness({ account: ACCOUNT }).app);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a website account with no Telegram behind it: it is in a browser already', async () => {
    const h = harness({ account: ACCOUNT, telegramId: null });
    expect(await ask(h.app)).toMatchObject({ status: 409, body: { message: 'NOT_A_TELEGRAM_ACCOUNT' } });
    expect(h.issueBotSigninToken).not.toHaveBeenCalled();
  });
});

describe('the account that tapped', () => {
  it('refuses a session that is ANOTHER Telegram account than the tap’s', async () => {
    // THE CASE. Account 5151 taps «Кабинет» on a phone whose shared cookie store
    // holds account 4242's session. A key for the session would open 4242's
    // cabinet in 5151's browser.
    const h = harness({ account: ACCOUNT, telegramId: '4242' });
    expect(await ask(h.app, signedLaunchData(5151))).toMatchObject({
      status: 409,
      body: { message: 'LAUNCH_ACCOUNT_MISMATCH' },
    });
    expect(h.issueBotSigninToken).not.toHaveBeenCalled();
  });

  it('asks for the launch data, and issues nothing without it', async () => {
    const h = harness({ account: ACCOUNT });
    expect(await ask(h.app, null)).toMatchObject({ status: 401, body: { message: 'LAUNCH_DATA_REQUIRED' } });
    expect(h.getSession).not.toHaveBeenCalled();
    expect(h.issueBotSigninToken).not.toHaveBeenCalled();
  });

  it('never trusts an unsigned id: launch data signed with another token is refused', async () => {
    // The user id in it matches the session — only the signature is wrong. An
    // id read without checking the HMAC would pass this; the route must not.
    const h = harness({ account: ACCOUNT, telegramId: '4242' });
    expect(await ask(h.app, signedLaunchData(4242, { token: '999:not-our-bot' }))).toMatchObject({
      status: 401,
      body: { message: 'LAUNCH_DATA_INVALID' },
    });
    expect(h.issueBotSigninToken).not.toHaveBeenCalled();
  });

  it('refuses launch data past its 24-hour window', async () => {
    const h = harness({ account: ACCOUNT, telegramId: '4242' });
    const dayAndAMinuteAgo = Math.floor(Date.now() / 1000) - 86_400 - 60;
    expect(await ask(h.app, signedLaunchData(4242, { authDate: dayAndAMinuteAgo }))).toMatchObject({
      status: 401,
      body: { message: 'LAUNCH_DATA_INVALID' },
    });
  });

  it('issues nothing when it has no bot token to check the launch data with', async () => {
    const h = harness({ account: ACCOUNT, botToken: null });
    expect(await ask(h.app)).toMatchObject({ status: 503 });
    expect(h.issueBotSigninToken).not.toHaveBeenCalled();
  });
});

describe('when the panel does not hand one over', () => {
  it('says the key was not issued rather than sending an empty one', async () => {
    const h = harness({ account: ACCOUNT, issue: async () => ({ token: null, expiresAt: null }) });
    expect(await ask(h.app)).toMatchObject({ status: 409, body: { message: 'KEY_NOT_ISSUED' } });
  });

  it('answers 502, and logs it, when the panel fails', async () => {
    const h = harness({
      account: ACCOUNT,
      issue: async () => {
        throw new Error('panel down');
      },
    });
    expect(await ask(h.app)).toMatchObject({ status: 502, body: { message: 'KEY_NOT_ISSUED' } });
    expect(h.log.error).toHaveBeenCalled();
  });
});
