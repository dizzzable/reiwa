/**
 * Sign-in with Google, Yandex or Mail.ru into an account whose e-mail the panel
 * never verified is refused — and the customer is told why.
 *
 * The panel no longer links a provider's verified e-mail to an account where
 * that address was never verified here (an AltShop import carries the donor's
 * address unverified and without a password): it answers 409
 * `EXTERNAL_EMAIL_UNVERIFIED_ACCOUNT` (`rezeis-admin/test/external-auth-unverified-email.spec.ts`
 * pins that body). The callback then signs nobody in, and sends the browser to
 * `/sign-in?error=ext_email_unverified` — a page that says what happened —
 * instead of the generic "external sign-in failed, try again", which would send
 * the customer round the same loop for ever.
 *
 * The real auth router and `AdminClient`, against a stand-in panel over HTTP;
 * the cabinet driven socketless (`socketless-request.ts` says why).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import cookieParser from 'cookie-parser';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createAuthRouter } from '../../src/api/routes/auth.js';
import { loadConfig } from '../../src/core/config/index.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
import { WebSessionStore } from '../../src/infrastructure/redis/session.js';
import { sendSocketless } from './socketless-request.js';

const servers: http.Server[] = [];
const clients: AdminClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

/** The panel's refusal on `oauth/resolve`, as its error filter writes it. */
function panelRefusal(code: string | null, status: number): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    path: '/api/internal/ext-auth/oauth/resolve',
    requestId: null,
    statusCode: status,
    message: 'An account with this e-mail exists, and the e-mail was never confirmed on it',
    errorCode: code ?? 'CONFLICT',
    ...(code === null ? {} : { code }),
    error: 'Conflict',
  };
}

/**
 * The shipped session store over a Redis that only counts, as the callback's
 * login limiter reads it: a Lua script answering `[count, ttl]`, and plain
 * keys. Nobody is near a limit here.
 */
function countingStore(): WebSessionStore {
  const keys = new Map<string, string>();
  const redis = {
    eval: async (_script: string, _keys: number, key: string, windowSeconds: number) => {
      const next = Number.parseInt(keys.get(key) ?? '0', 10) + 1;
      keys.set(key, String(next));
      return [next, windowSeconds];
    },
    get: async (key: string) => keys.get(key) ?? null,
    set: async (key: string, value: string) => {
      keys.set(key, value);
      return 'OK';
    },
    ttl: async () => 900,
    del: async (key: string) => (keys.delete(key) ? 1 : 0),
  };
  const store = Object.create(WebSessionStore.prototype) as WebSessionStore;
  (store as unknown as { redis: unknown }).redis = redis;
  return store;
}

async function cabinet(resolve: { status: number; body: unknown }) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls.push(req.url ?? '');
      res.statusCode = resolve.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(resolve.body));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  servers.push(server);
  const adminClient = new AdminClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'internal-token');
  clients.push(adminClient);

  const sessionsOpened: string[] = [];
  const app = express();
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.webSession = null;
    req.webSessionId = null;
    req.createWebSession = async (userId: string) => {
      sessionsOpened.push(userId);
      return 'session-that-must-not-exist';
    };
    next();
  });
  app.use(
    '/api/v1',
    createAuthRouter({ adminClient, sessionStore: null, webSessionStore: countingStore(), config: loadConfig({ NODE_ENV: 'test' }) }),
  );
  return { app, calls, sessionsOpened };
}

function callback(app: express.Express) {
  return sendSocketless(app, {
    method: 'GET',
    url: '/api/v1/auth/ext/google/callback?code=provider-code&state=state-1',
    headers: { cookie: 'ext_state=google:state-1; ext_verifier=verifier-1' },
  });
}

describe('the OAuth callback when the panel refuses an unverified e-mail match', () => {
  it('signs nobody in and sends the browser to a sign-in page that says why', async () => {
    const stand = await cabinet({ status: 409, body: panelRefusal('EXTERNAL_EMAIL_UNVERIFIED_ACCOUNT', 409) });

    const response = await callback(stand.app);

    expect(stand.calls, 'the callback never asked the panel').toEqual(['/api/internal/ext-auth/oauth/resolve']);
    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/sign-in?error=ext_email_unverified');
    expect(stand.sessionsOpened, 'a session was opened for the refused account').toEqual([]);
  });

  it('keeps the generic answer for every other refusal', async () => {
    const stand = await cabinet({ status: 409, body: panelRefusal(null, 409) });

    const response = await callback(stand.app);

    expect(response.headers['location']).toBe('/sign-in?error=ext_failed');
    expect(stand.sessionsOpened).toEqual([]);
  });
});
