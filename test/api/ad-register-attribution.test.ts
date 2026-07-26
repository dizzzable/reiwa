/**
 * Registration half of the advertising funnel.
 *
 * The capture middleware counts the open and parks the tracking code in a cookie
 * while the visitor is still anonymous; `POST /api/v1/auth/register` is what
 * turns that into an attributed account. Nothing gated this half before, and the
 * ordering inside it is load-bearing: the cookie must outlive a failed hand-off,
 * because on web it is the only carrier left (the middleware strips the param
 * out of the URL) and rezeis rejects unknown fields outright, so a reiwa build
 * that ships ahead of rezeis gets a hard 400 on `attributeOnly`.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { describe, it } from 'vitest';
import cookieParser from 'cookie-parser';
import express from 'express';

import type { AdminClient } from '../../src/lib/admin-client.js';
import type { ReiwaConfig } from '../../src/config.js';
import type { WebSessionStore } from '../../src/infrastructure/redis/session.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';

interface Result {
  readonly status: number;
  readonly setCookie: readonly string[];
  readonly body: Record<string, unknown>;
}

/** Redis stub that lets the register rate limiter through (1 hit, 60s window). */
function createRedisStub() {
  return {
    get: async () => null,
    eval: async () => [1, 60],
  };
}

function createAdminClientStub(options: { recordClick?: () => Promise<unknown> } = {}) {
  const clicks: Record<string, unknown>[] = [];
  const client = {
    webAuth: {
      register: async () => ({ userId: 'user-1', webAccountId: 'wa-1' }),
    },
    advertising: {
      recordClick: async (input: Record<string, unknown>) => {
        clicks.push(input);
        return options.recordClick === undefined ? { ok: true } : options.recordClick();
      },
    },
  } as unknown as AdminClient;
  return { clicks, client };
}

function buildApp(adminClient: AdminClient): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // `requireMode` reads the admin client off app.locals and fails open when the
  // policy cache is unavailable, which is what we want in a unit test.
  app.locals['adminClient'] = null;
  app.use((req, _res, next) => {
    (req as unknown as { createWebSession: (userId: string) => Promise<string> }).createWebSession =
      async () => 'session-1';
    next();
  });
  app.use(
    '/api/v1',
    createAuthRouter({
      adminClient,
      sessionStore: null,
      webSessionStore: {
        getRedis: () => createRedisStub(),
      } as unknown as WebSessionStore,
      config: { NODE_ENV: 'test' } as unknown as ReiwaConfig,
    }),
  );
  return app;
}

const VALID_BODY = {
  username: 'ad_tester_01',
  passwordHash: 'a'.repeat(64),
};

async function register(app: express.Express, cookie?: string): Promise<Result> {
  const server = http.createServer(app);
  return new Promise<Result>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const payload = JSON.stringify(VALID_BODY);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/auth/register',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(cookie === undefined ? {} : { Cookie: cookie }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const raw = response.headers['set-cookie'];
            const result: Result = {
              status: response.statusCode ?? 500,
              setCookie: Array.isArray(raw) ? raw : raw === undefined ? [] : [raw],
              body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
                string,
                unknown
              >,
            };
            server.closeAllConnections();
            server.close(() => resolve(result));
          });
        },
      );
      req.on('error', (error) => {
        server.closeAllConnections();
        server.close();
        reject(error);
      });
      req.write(payload);
      req.end();
    });
  });
}

function adCookieHeader(cookies: readonly string[]): string | undefined {
  return cookies.find((value) => value.startsWith('ad_code='));
}

describe('POST /auth/register — advertising attribution', () => {
  it('binds the new account to the placement and drops the cookie', async () => {
    const admin = createAdminClientStub();
    const result = await register(buildApp(admin.client), 'ad_code=WIcpYLNTs5');

    assert.equal(result.status, 200);
    assert.equal(result.body['success'], true);
    // attributeOnly is the whole point: the open was already counted on landing,
    // so this call must claim first-touch without recording a second AdClick.
    assert.deepEqual(admin.clicks, [
      {
        code: 'WIcpYLNTs5',
        userId: 'user-1',
        surface: 'WEB',
        isNewUser: true,
        attributeOnly: true,
      },
    ]);
    const cleared = adCookieHeader(result.setCookie);
    assert.ok(cleared !== undefined, 'a confirmed attribution must expire the cookie');
    assert.match(cleared, /ad_code=;/);
  });

  it('keeps the cookie when rezeis rejects the hand-off, so it can be retried', async () => {
    // The failure that matters in practice: rezeis restarting, or a deploy where
    // reiwa runs ahead of rezeis and `forbidNonWhitelisted` 400s on attributeOnly.
    // Clearing the cookie here used to lose the attribution permanently.
    const admin = createAdminClientStub({
      recordClick: async () => {
        throw new Error('Request failed with status code 400');
      },
    });
    const result = await register(buildApp(admin.client), 'ad_code=WIcpYLNTs5');

    assert.equal(result.status, 200, 'a signup must never fail because attribution did');
    assert.equal(result.body['success'], true);
    assert.equal(admin.clicks.length, 1);
    assert.equal(
      adCookieHeader(result.setCookie),
      undefined,
      'an unconfirmed attribution must leave the parked code alone',
    );
  });

  it('does not call attribution when the browser carries no ad code', async () => {
    const admin = createAdminClientStub();
    const result = await register(buildApp(admin.client));

    assert.equal(result.status, 200);
    assert.deepEqual(admin.clicks, []);
    assert.equal(adCookieHeader(result.setCookie), undefined);
  });

  it('ignores a malformed ad_code cookie', async () => {
    const admin = createAdminClientStub();
    const result = await register(buildApp(admin.client), 'ad_code=not%20a%20code!!');

    assert.equal(result.status, 200);
    assert.deepEqual(admin.clicks, []);
  });
});
