/**
 * `POST /api/v1/auth/browser-key` — a one-time key to open the cabinet in the
 * phone's own browser, signed in. Asked by the Mini App's `/open-in-browser`.
 *
 * The key is the bot's own `bot-signin`, spent by `/auth/bot-signin` like every
 * other; this route only decides WHO may ask. Each case is one way that could
 * go wrong: a caller with no session, a session asking for somebody else's
 * account, a website account with no Telegram behind it, a panel that could not
 * issue — and a key left behind in a cache.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserKeyRouter } from '../../src/api/routes/browser-key.js';
import { sendSocketless, type SocketlessResponse } from './socketless-request.js';

const ACCOUNT = 'cm0account000000000000001';
const KEY = 'e5'.repeat(32);

interface Options {
  /** The signed-in account; absent for no session. */
  readonly account?: string;
  readonly telegramId?: string | null;
  readonly issue?: (telegramId: string) => Promise<{ token: string | null; expiresAt: string | null }>;
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
    }),
  );
  return { app, getSession, issueBotSigninToken, log };
}

function ask(app: express.Express): Promise<SocketlessResponse> {
  return sendSocketless(app, { method: 'POST', url: '/api/v1/auth/browser-key', body: {} });
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
