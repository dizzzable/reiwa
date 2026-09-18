/**
 * A fresh answer before money moves or a credential changes.
 *
 * The session middleware asks the panel about a session at most once a
 * minute, and lets a request through when the panel cannot tell. Before a
 * withdrawal, a purchase paid with the partner balance, a password change and
 * linking a Telegram or an e-mail, the cabinet now asks AGAIN, with no minute
 * of grace, and fails CLOSED:
 *
 *   - a session signed out elsewhere a few seconds ago — inside its minute — is
 *     ended there and then (401 `SESSION_REVOKED`), and the action never
 *     reaches the panel;
 *   - a panel that cannot say — failing, or silent past the deadline — refuses
 *     the action (503 `SESSION_CHECK_UNAVAILABLE`), and nothing is done;
 *   - an ordinary session goes through, and so does every session on a panel
 *     older than the sign-out itself (its route is missing: nothing of this
 *     customer was ever revoked by it).
 *
 * Nothing between the routes and the panel is a double: the real session
 * middleware and store (over a Redis that is a `Map`), the real routers, and
 * the real `AdminClient` calling a stand-in panel over HTTP. Requests to the
 * cabinet go socketless (`socketless-request.ts` says why).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import cookieParser from 'cookie-parser';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { FRESH_ANSWER_DEADLINE_MS, createSessionRevocationCheck, isRevocationCheckedPath } from '../../src/api/lib/session-revocation.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createLinkingRouter } from '../../src/api/routes/linking.js';
import { createPartnerRouter } from '../../src/api/routes/partner.js';
import { createProfileRouter } from '../../src/api/routes/profile.js';
import { loadConfig } from '../../src/core/config/index.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
import { WebSessionStore, createWebSessionMiddleware, type WebSession } from '../../src/infrastructure/redis/session.js';
import { sendSocketless, type SocketlessRequest } from './socketless-request.js';

const COOKIE = 'reiwa_web_session';
const MINUTE = 60_000;
const USER = 'user-fresh';

/** Every route that moves money or changes a credential, as the browser calls it. */
const ACTIONS: ReadonlyArray<Omit<SocketlessRequest, 'headers'> & { readonly label: string }> = [
  { label: 'partner withdraw', method: 'POST', url: '/api/v1/partner/withdraw', body: { amount: 1000, method: 'card', requisites: '4242' } },
  { label: 'partner pay', method: 'POST', url: '/api/v1/partner/pay', body: { purchaseType: 'RENEW', planId: 'plan-1', durationDays: 30 } },
  { label: 'change password', method: 'POST', url: '/api/v1/auth/change-password', body: { currentPasswordHash: 'a'.repeat(64), newPasswordHash: 'b'.repeat(64) } },
  { label: 'link Telegram', method: 'POST', url: '/api/v1/link/telegram/initiate' },
  { label: 'link e-mail', method: 'POST', url: '/api/v1/link/email/initiate', body: { email: 'owner@example.com' } },
  { label: 'confirm e-mail link', method: 'POST', url: '/api/v1/link/email/verify', body: { code: '123456' } },
  { label: 'e-mail challenge', method: 'POST', url: '/api/v1/me/email/challenge', body: { email: 'owner@example.com' } },
  { label: 'e-mail verify', method: 'PATCH', url: '/api/v1/me/email/verify', body: { code: '123456' } },
];

// ── The store: the shipped class over a Redis that is a Map ────────────────

function liveStore() {
  const rows = new Map<string, string>();
  const redis = {
    async set(key: string, value: string): Promise<'OK'> {
      rows.set(key, value);
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      return rows.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      return rows.delete(key) ? 1 : 0;
    },
  };
  const store = Object.create(WebSessionStore.prototype) as WebSessionStore;
  (store as unknown as { redis: unknown }).redis = redis;
  const keyOf = (sessionId: string) => [...rows.keys()].find((key) => key.endsWith(sessionId));
  return {
    store,
    exists: (sessionId: string): boolean => keyOf(sessionId) !== undefined,
    patch(sessionId: string, fields: Partial<WebSession>): void {
      const key = keyOf(sessionId);
      if (key === undefined) throw new Error(`no session ${sessionId}`);
      rows.set(key, JSON.stringify({ ...JSON.parse(rows.get(key)!), ...fields }));
    },
  };
}

// ── A stand-in panel, over a real socket ────────────────────────────────────

type StateAnswer = { readonly status: number; readonly body: unknown; readonly delayMs?: number };

const servers: http.Server[] = [];
const clients: AdminClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    }),
  );
});

/**
 * `sessions/state` answers what the case says; every other internal route —
 * the ACTIONS' own — answers 200 with a body every handler can read, and is
 * recorded, so a case can say the action never reached the panel.
 */
async function standInPanel(state: () => StateAnswer) {
  const actions: string[] = [];
  let asked = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      const answer: StateAnswer = url.startsWith('/api/internal/web-auth/sessions/state')
        ? (asked += 1, state())
        : (actions.push(`${req.method ?? ''} ${url.split('?')[0]}`),
          {
            status: 200,
            body: { success: true, code: '123456', expiresAt: new Date(Date.now() + MINUTE).toISOString(), verified: true, paymentId: 'pay-1', id: 'w-1' },
          });
      const send = () => {
        res.statusCode = answer.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(answer.body));
      };
      if (answer.delayMs === undefined) send();
      else setTimeout(send, answer.delayMs);
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  servers.push(server);
  const client = new AdminClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'internal-token');
  clients.push(client);
  return {
    client,
    actions,
    get asked() {
      return asked;
    },
  };
}

/** What a panel older than the route answers for it, through its error filter. */
const MISSING_ROUTE: StateAnswer = {
  status: 404,
  body: {
    timestamp: new Date().toISOString(),
    path: '/api/internal/web-auth/sessions/state',
    requestId: null,
    statusCode: 404,
    message: 'Request failed',
    errorCode: 'NOT_FOUND',
    error: 'Not Found',
  },
};

// ── The cabinet ─────────────────────────────────────────────────────────────

function cabinet(store: WebSessionStore, adminClient: AdminClient) {
  const config = loadConfig({ NODE_ENV: 'test' });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    createWebSessionMiddleware(store, { redisUrl: '', cookieSecure: false, isProduction: false }, undefined, {
      revocation: createSessionRevocationCheck(adminClient.webAuth),
      revocationCheckedPath: isRevocationCheckedPath,
    }),
  );
  app.use('/api/v1', createPartnerRouter({ adminClient, sessionStore: null, config }));
  app.use('/api/v1', createAuthRouter({ adminClient, sessionStore: null, webSessionStore: store, config }));
  app.use('/api/v1', createLinkingRouter({ adminClient, webSessionStore: store, config }));
  app.use('/api/v1', createProfileRouter({ adminClient, sessionStore: null, config }));
  return app;
}

/**
 * A session the minute-cache would let through: opened half an hour ago, and
 * asked about ten seconds ago, so the middleware does not ask again.
 */
async function sessionInsideTheMinute(live: ReturnType<typeof liveStore>): Promise<string> {
  const sessionId = await live.store.create({ userId: USER }, '127.0.0.1');
  live.patch(sessionId, { createdAt: Date.now() - 30 * MINUTE, revocationCheckedAt: Date.now() - 10_000 });
  return sessionId;
}

function perform(app: express.Express, action: (typeof ACTIONS)[number], sessionId: string) {
  return sendSocketless(app, { ...action, headers: { cookie: `${COOKIE}=${sessionId}` } });
}

describe('the fresh check before money and credential routes', () => {
  it('ends a session signed out elsewhere inside its minute, on every one of them, before the action reaches the panel', async () => {
    const live = liveStore();
    const signedOutAt = new Date(Date.now() - 5_000).toISOString();
    const panel = await standInPanel(() => ({ status: 200, body: { sessionsRevokedAt: signedOutAt, now: new Date().toISOString() } }));
    const app = cabinet(live.store, panel.client);

    for (const action of ACTIONS) {
      const sessionId = await sessionInsideTheMinute(live);
      const response = await perform(app, action, sessionId);
      expect(response.status, `${action.label} went through for a signed-out session`).toBe(401);
      expect(response.body, action.label).toEqual({ code: 'SESSION_REVOKED', message: 'This session was signed out. Sign in again.' });
      expect(live.exists(sessionId), `${action.label}: the signed-out session is still in Redis`).toBe(false);
    }
    expect(panel.actions, 'an action reached the panel for a signed-out session').toEqual([]);
    expect(panel.asked).toBe(ACTIONS.length);
  });

  it('refuses every one of them when the panel fails to say, and does nothing', async () => {
    const live = liveStore();
    const panel = await standInPanel(() => ({ status: 500, body: { statusCode: 500, message: 'Internal server error' } }));
    const app = cabinet(live.store, panel.client);

    for (const action of ACTIONS) {
      const sessionId = await sessionInsideTheMinute(live);
      const response = await perform(app, action, sessionId);
      expect(response.status, action.label).toBe(503);
      expect((response.body as { code?: string }).code, action.label).toBe('SESSION_CHECK_UNAVAILABLE');
      expect(live.exists(sessionId), `${action.label}: a panel that could not say ended the session`).toBe(true);
    }
    expect(panel.actions).toEqual([]);
  });

  it(
    'refuses when the panel is silent past the deadline — it does not wait for ever, and does nothing',
    async () => {
      const live = liveStore();
      const panel = await standInPanel(() => ({
        status: 200,
        body: { sessionsRevokedAt: null, now: new Date().toISOString() },
        delayMs: FRESH_ANSWER_DEADLINE_MS + 2_000,
      }));
      const app = cabinet(live.store, panel.client);
      const sessionId = await sessionInsideTheMinute(live);

      const started = Date.now();
      const response = await perform(app, ACTIONS[0]!, sessionId);

      expect(response.status).toBe(503);
      expect((response.body as { code?: string }).code).toBe('SESSION_CHECK_UNAVAILABLE');
      expect(Date.now() - started).toBeLessThan(FRESH_ANSWER_DEADLINE_MS + 1_500);
      expect(panel.actions).toEqual([]);
    },
    20_000,
  );

  it('lets an ordinary session through on every one of them — nothing revoked, or revoked before it started', async () => {
    const live = liveStore();
    let moment: string | null = null;
    const panel = await standInPanel(() => ({ status: 200, body: { sessionsRevokedAt: moment, now: new Date().toISOString() } }));
    const app = cabinet(live.store, panel.client);

    for (const revoked of [null, new Date(Date.now() - 2 * 60 * MINUTE).toISOString()]) {
      moment = revoked;
      for (const action of ACTIONS) {
        const before = panel.actions.length;
        const response = await perform(app, action, await sessionInsideTheMinute(live));
        expect(response.status, `${action.label} was refused for an ordinary session`).toBeLessThan(300);
        expect(panel.actions.length, `${action.label} never reached the panel`).toBeGreaterThan(before);
      }
    }
  });

  it('lets them through on a panel older than the sign-out itself — its route is missing, nothing was ever revoked', async () => {
    const live = liveStore();
    const panel = await standInPanel(() => MISSING_ROUTE);
    const app = cabinet(live.store, panel.client);

    for (const action of ACTIONS) {
      const before = panel.actions.length;
      const response = await perform(app, action, await sessionInsideTheMinute(live));
      expect(response.status, `${action.label} was refused because the panel is older`).toBeLessThan(300);
      expect(panel.actions.length, `${action.label} never reached the panel`).toBeGreaterThan(before);
    }
  });
});
