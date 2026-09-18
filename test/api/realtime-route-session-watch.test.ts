/**
 * The realtime route hands the proxy the question "is the session this stream
 * was opened with still good?" — and asks it of the right session.
 *
 * `realtime-session-end.test.ts` proves the proxy ends a stream on `false` and
 * that the middleware's question is right; this pins the wiring between them,
 * which neither of those can see: a route that forgot to pass the watch, or
 * passed one judging nothing, would leave both green.
 *
 *   - a web session is judged by the middleware's `revalidateWebSession`;
 *   - a stream opened with a Telegram session alone is judged by whether that
 *     session still exists;
 *   - with neither there is nothing that can end, and the stream is kept.
 */
import cookieParser from 'cookie-parser';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StreamSessionWatch } from '../../src/api/routes/realtime-proxy.js';

const proxied = vi.hoisted(() => ({ watches: [] as Array<StreamSessionWatch | undefined> }));

vi.mock('../../src/api/routes/realtime-proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/routes/realtime-proxy.js')>();
  return {
    ...actual,
    proxyStream: async (_client: unknown, _userRef: string, res: express.Response, _onError: unknown, watch?: StreamSessionWatch) => {
      proxied.watches.push(watch);
      res.status(200).end();
    },
  };
});

import { createRealtimeRouter } from '../../src/api/routes/realtime.js';
import type { AdminClient } from '../../src/lib/admin-client.js';
import type { ReiwaSession, SessionStore } from '../../src/lib/session-store.js';
import { sendSocketless } from './socketless-request.js';

/** A Telegram session store with one session in it, until the case removes it. */
function telegramSessions(): { store: Pick<SessionStore, 'get' | 'refresh'>; remove(): void } {
  let present = true;
  const session: ReiwaSession = { telegramId: '700001', userId: 1, name: 'Telegram user', role: 'USER', createdAt: Date.now() };
  const store: Pick<SessionStore, 'get' | 'refresh'> = {
    get: async (id: string) => (present && id === 'tg-session' ? session : null),
    refresh: async () => undefined,
  };
  return { store, remove: () => void (present = false) };
}

/** The route, behind a stand-in for the web session middleware that records the question. */
function realtimeApp(
  web: { readonly userId: string; readonly valid: () => Promise<boolean> } | null,
  sessionStore: Pick<SessionStore, 'get' | 'refresh'> | null,
) {
  const app = express();
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.webSession = web === null ? null : { userId: web.userId, createdAt: Date.now(), ip: '127.0.0.1', lastActivity: Date.now() };
    req.webSessionId = web === null ? null : 'web-session';
    req.revalidateWebSession = web === null ? async () => true : web.valid;
    next();
  });
  // The (mocked) proxy never opens anything; the route only needs a client to hand it.
  const adminClient: Pick<AdminClient, 'openStream'> = { openStream: async () => null };
  app.use(
    '/api/v1',
    createRealtimeRouter({ adminClient: adminClient as AdminClient, sessionStore: sessionStore as SessionStore | null }),
  );
  return app;
}

afterEach(() => {
  proxied.watches.length = 0;
});

describe('the realtime route watches the session its stream was opened with', () => {
  it('judges a web session by the middleware’s own question', async () => {
    let answer = true;
    let asked = 0;
    const app = realtimeApp(
      {
        userId: 'user-a',
        valid: async () => {
          asked += 1;
          return answer;
        },
      },
      null,
    );

    await sendSocketless(app, { method: 'GET', url: '/api/v1/realtime/stream' });

    const watch = proxied.watches[0];
    expect(watch, 'the stream was opened with nothing to end it').toBeDefined();
    expect(await watch!.stillValid()).toBe(true);
    answer = false;
    expect(await watch!.stillValid()).toBe(false);
    expect(asked).toBe(2);
  });

  it('judges a stream opened with a Telegram session alone by whether that session still exists', async () => {
    const telegram = telegramSessions();
    const app = realtimeApp(null, telegram.store);

    await sendSocketless(app, {
      method: 'GET',
      url: '/api/v1/realtime/stream',
      headers: { cookie: 'reiwa_session=tg-session' },
    });

    const watch = proxied.watches[0];
    expect(watch).toBeDefined();
    expect(await watch!.stillValid()).toBe(true);
    telegram.remove();
    expect(await watch!.stillValid(), 'a signed-out Telegram session kept its stream').toBe(false);
  });
});
