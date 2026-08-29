import express from 'express';
import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { createUserHintsRouter } from '../../src/api/routes/user-hints.js';

/**
 * The cabinet's side of the hint queue.
 *
 * Two properties matter more than any single assertion.
 *
 * THE IDENTITY COMES FROM THE SESSION. Hints are raised by events like "your
 * payment failed" and "your subscription ended", so a body that named its own
 * user id would be a readable trail of somebody else's account. The surface and
 * form factor DO come from the body, because only the browser knows them — but
 * they can only narrow what this session already sees, so lying wins nothing.
 *
 * NOTHING HERE MAY BREAK A PAGE. A hint is the least important thing on any
 * screen it appears on. When the panel is unreachable the cabinet must render
 * as though there were nothing to show, never surface an error about a feature
 * the customer did not ask for.
 */

interface Captured {
  readonly call: string;
  readonly input: Record<string, unknown>;
}

const A_HINT = {
  deliveryId: 'del-1',
  key: 'connect',
  mode: 'MODAL',
  tone: 'INFO',
  title: 'Готово',
  body: 'Вот как подключиться',
  ctaKind: 'ROUTE',
  ctaLabel: 'Открыть',
  ctaTarget: '/settings/faq',
};

function makeApp(
  options: {
    readonly userId?: string | null;
    readonly upstreamThrows?: boolean;
    readonly noAdminClient?: boolean;
  } = {},
) {
  const captured: Captured[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (options.userId !== null) {
      req.webSession = {
        userId: options.userId ?? 'user-1',
        createdAt: Date.now(),
        ip: '127.0.0.1',
        lastActivity: Date.now(),
      };
      req.webSessionId = 'session-1';
    }
    next();
  });

  function record<T>(call: string, answer: T) {
    return async (input: Record<string, unknown>): Promise<T> => {
      if (options.upstreamThrows === true) throw new Error('panel is down');
      captured.push({ call, input });
      return answer;
    };
  }

  app.use(
    '/api/v1',
    createUserHintsRouter({
      adminClient: options.noAdminClient
        ? null
        : ({
            userHints: {
              next: record('next', { hint: A_HINT }),
              moment: record('moment', { raised: true }),
              markShown: record('markShown', { ok: true }),
              close: record('close', { ok: true }),
            },
          } as never),
      sessionStore: null,
    }),
  );
  return { app, captured };
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const payload = JSON.stringify(body);
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('who the hints belong to', () => {
  it('takes the user from the session, not from the body', async () => {
    const { app, captured } = makeApp({ userId: 'real-user' });

    await postJson(app, '/api/v1/hints/next', {
      userId: 'somebody-else',
      telegramId: '999',
      surface: 'browser',
      formFactor: 'mobile',
    });

    expect(captured[0].input.userId).toBe('real-user');
    // And the impersonation attempt leaves no trace in what went upstream.
    expect(captured[0].input.telegramId).toBeUndefined();
  });

  it('never reaches the panel without a session', async () => {
    // The session middleware refuses it before the handler runs, so there is no
    // body to speak of — the assertion that matters is that nothing was asked
    // upstream on behalf of a caller we cannot name.
    const { app, captured } = makeApp({ userId: null });

    const res = await postJson(app, '/api/v1/hints/next', { surface: 'browser' });

    expect(res.status).not.toBe(200);
    expect(captured).toEqual([]);
  });
});

describe('the audience the browser reports', () => {
  it('passes the surface and form factor through', async () => {
    // These only narrow what the session already sees, which is why they are
    // allowed to come from the client at all.
    const { app, captured } = makeApp();

    await postJson(app, '/api/v1/hints/next', {
      surface: 'tma',
      formFactor: 'tablet',
      locale: 'en',
    });

    expect(captured[0].input.surface).toBe('tma');
    expect(captured[0].input.formFactor).toBe('tablet');
    expect(captured[0].input.locale).toBe('en');
  });

  it('drops a surface that is not one of the three', async () => {
    // Left undefined rather than forwarded: the panel then applies its own
    // default instead of matching a hint against a value nobody defined.
    const { app, captured } = makeApp();

    await postJson(app, '/api/v1/hints/next', { surface: 'smart-fridge' });

    expect(captured[0].input.surface).toBeUndefined();
  });

  it('falls back to Russian for an unknown locale', async () => {
    const { app, captured } = makeApp();

    await postJson(app, '/api/v1/hints/next', { locale: 'klingon' });

    expect(captured[0].input.locale).toBe('ru');
  });
});

describe('moments the cabinet reports', () => {
  it('forwards the one moment it knows', async () => {
    const { app, captured } = makeApp();

    const res = await postJson(app, '/api/v1/hints/moment', { moment: 'subscription-ready' });

    expect(res.body.raised).toBe(true);
    expect(captured[0].call).toBe('moment');
  });

  it('refuses a moment nobody declared', async () => {
    // A browser must not be able to queue an arbitrary hint out of context,
    // even one addressed to itself: the moment name IS the hint key.
    const { app, captured } = makeApp();

    const res = await postJson(app, '/api/v1/hints/moment', { moment: 'payment-failed' });

    expect(res.body.raised).toBe(false);
    expect(captured).toEqual([]);
  });
});

describe('recording the outcome', () => {
  it('passes “acted” through', async () => {
    const { app, captured } = makeApp();

    await postJson(app, '/api/v1/hints/closed', { deliveryId: 'del-1', outcome: 'acted' });

    expect(captured[0].input.outcome).toBe('acted');
  });

  it('treats anything else as a dismissal', async () => {
    // The safe default. Over-counting "closed to be rid of it" understates how
    // well a hint works; the reverse would make every hint look useful.
    const { app, captured } = makeApp();

    await postJson(app, '/api/v1/hints/closed', { deliveryId: 'del-1', outcome: 'maybe' });

    expect(captured[0].input.outcome).toBe('dismissed');
  });

  it('refuses a request with no delivery id', async () => {
    const { app, captured } = makeApp();

    const res = await postJson(app, '/api/v1/hints/closed', {});

    expect(res.body.ok).toBe(false);
    expect(captured).toEqual([]);
  });
});

describe('a hint never breaks the page', () => {
  it('answers “no hint” when the panel is down', async () => {
    const { app } = makeApp({ upstreamThrows: true });

    const res = await postJson(app, '/api/v1/hints/next', { surface: 'browser' });

    expect(res.status).toBe(200);
    expect(res.body.hint).toBeNull();
  });

  it('answers “no hint” when there is no panel connection at all', async () => {
    const { app } = makeApp({ noAdminClient: true });

    const res = await postJson(app, '/api/v1/hints/next', { surface: 'browser' });

    expect(res.status).toBe(200);
    expect(res.body.hint).toBeNull();
  });

  it('swallows a failure while recording the outcome', async () => {
    // The customer is reading the hint at this moment. An error here would be
    // an error about the thing that was meant to help.
    const { app } = makeApp({ upstreamThrows: true });

    const res = await postJson(app, '/api/v1/hints/closed', {
      deliveryId: 'del-1',
      outcome: 'acted',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });
});
