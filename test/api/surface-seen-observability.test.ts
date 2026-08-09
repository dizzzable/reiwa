import express from 'express';
import http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { createProfileRouter } from '../../src/api/routes/profile.js';
import { UpstreamError } from '../../src/core/errors/index.js';

/**
 * `POST /surface/seen` must not fail SILENTLY.
 *
 * Two things are true at once and the old code only honoured the first:
 * the cabinet must never break on usage analytics, AND a total loss of usage
 * analytics must not look exactly like normal operation. The handler caught
 * both of its awaits with a bare `catch {}`, so it always answered
 * `200 {ok:true}` and there was nothing anywhere — no log, no metric, no
 * failing test — to distinguish "every session recorded" from "none".
 *
 * That is not hypothetical for this endpoint in particular. rezeis-admin
 * validates the body with a global `ValidationPipe({ whitelist: true,
 * forbidNonWhitelisted: true })` against a closed-allowlist DTO
 * (`internal-surface-seen.dto.ts`), so an undeclared field is a hard 400 rather
 * than a silent strip: shipping a new field from reiwa before the admin DTO
 * accepts it stops `surface`, `formFactor` AND `os` together. The `tgWebAppPlatform`
 * pass-through is a live proposal, and this catch is what would make getting
 * that deploy order wrong invisible.
 *
 * The second `catch` in the same handler is not analytics at all: it upgrades an
 * installed-PWA session to the 30-day window, and failing silently there is
 * experienced by the user as being logged out days early for no reason. It gets
 * the same treatment, and the same "still 200" guarantee.
 *
 * Both cases below assert BOTH halves — the warn fires, and the response is
 * still the 200 the cabinet depends on.
 */

interface Captured {
  readonly ctx: object;
  readonly message: string;
}

/**
 * Mounts the profile router with a request logger the test can read.
 *
 * `getRequestLogger` returns `req.log` when pino-http has attached one, which is
 * exactly what production has; attaching a fake here exercises the real accessor
 * rather than a stub of it.
 */
function makeApp(options: {
  readonly recordSurfaceSeen: () => Promise<unknown>;
  readonly markSessionStandalone?: () => Promise<void>;
  readonly warnings: Captured[];
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.webSession = {
      userId: 'u1',
      createdAt: Date.now(),
      ip: '127.0.0.1',
      lastActivity: Date.now(),
    };
    req.webSessionId = 'session-1';
    req.markSessionStandalone =
      options.markSessionStandalone ?? (async () => undefined);
    (req as unknown as { log: unknown }).log = {
      info: () => undefined,
      debug: () => undefined,
      error: () => undefined,
      warn: (ctxOrMessage: object | string, message?: string) => {
        options.warnings.push(
          typeof ctxOrMessage === 'string'
            ? { ctx: {}, message: ctxOrMessage }
            : { ctx: ctxOrMessage, message: message ?? '' },
        );
      },
      child: () => (req as unknown as { log: unknown }).log,
    };
    next();
  });
  app.use(
    '/api/v1',
    createProfileRouter({
      adminClient: {
        user: { recordSurfaceSeen: options.recordSurfaceSeen },
      } as never,
      sessionStore: null,
      config: { NODE_ENV: 'test' } as never,
    }),
  );
  return app;
}

async function postSurface(
  app: express.Express,
  body: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const payload = JSON.stringify(body);
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/surface/seen',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
          );
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('POST /surface/seen — a failed persist is reported, never swallowed', () => {
  it('warns when the usage-analytics persist is rejected, and still answers 200', async () => {
    const warnings: Captured[] = [];
    // The exact shape the closed-allowlist DTO produces for an undeclared
    // field: a hard 400 that takes the whole record down with it.
    const recordSurfaceSeen = vi.fn(async () => {
      throw new UpstreamError(
        'POST',
        '/api/internal/user/surface-seen',
        400,
        '{"message":["property tgWebAppPlatform should not exist"]}',
      );
    });

    const response = await postSurface(
      makeApp({ recordSurfaceSeen, warnings }),
      { surface: 'tma', formFactor: 'mobile', os: 'ios' },
    );

    expect(
      response,
      'the cabinet now breaks on a failed analytics persist — reporting the surface must never cost the user their session',
    ).toEqual({ status: 200, body: { ok: true } });
    expect(recordSurfaceSeen).toHaveBeenCalledTimes(1);

    const warned = warnings.find((entry) => entry.message.includes('surface/seen'));
    expect(
      warned,
      'a rejected usage-analytics persist produced no log line at all — a total loss of surface analytics is once again indistinguishable from normal operation, which is exactly how a DTO mismatch would ship unnoticed',
    ).toBeDefined();
    // Enough to diagnose without going back to the client: which persist, what
    // the upstream said, and the record that was refused.
    expect(warned?.ctx).toMatchObject({ surface: 'tma', formFactor: 'mobile', os: 'ios' });
    expect(String((warned?.ctx as { err?: unknown }).err)).toContain('tgWebAppPlatform');
  });

  it('warns when the installed-PWA session upgrade fails, and still answers 200', async () => {
    const warnings: Captured[] = [];
    const markSessionStandalone = vi.fn(async () => {
      throw new Error('redis unavailable');
    });

    const response = await postSurface(
      makeApp({
        recordSurfaceSeen: vi.fn(async () => ({ ok: true })),
        markSessionStandalone,
        warnings,
      }),
      { surface: 'pwa', formFactor: 'desktop', os: 'windows' },
    );

    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(markSessionStandalone).toHaveBeenCalledTimes(1);
    expect(
      warnings.find((entry) => entry.message.includes('standalone session upgrade')),
      "the 30-day session upgrade failed silently — the user's installed PWA logs them out days early and nothing anywhere says why",
    ).toBeDefined();
  });

  it('stays quiet on the happy path', async () => {
    const warnings: Captured[] = [];

    const response = await postSurface(
      makeApp({ recordSurfaceSeen: vi.fn(async () => ({ ok: true })), warnings }),
      { surface: 'browser', formFactor: 'desktop', os: 'linux' },
    );

    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(
      warnings,
      'every successful report now logs a warning — a log that fires on the happy path is one nobody reads on the unhappy one',
    ).toEqual([]);
  });
});
