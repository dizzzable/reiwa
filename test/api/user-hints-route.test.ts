import express from 'express';
import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { createUserHintsRouter } from '../../src/api/routes/user-hints.js';
import { UpstreamError } from '../../src/core/errors/index.js';

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

/** One line the route wrote through `req.log`, whatever its level. */
interface LogLine {
  readonly level: string;
  readonly context: Record<string, unknown>;
  readonly message: string;
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
    /** Thrown by every upstream call in place of an answer. */
    readonly upstreamError?: unknown;
    readonly noAdminClient?: boolean;
    /** The clock the route's warn throttle reads. */
    readonly now?: () => number;
  } = {},
) {
  const captured: Captured[] = [];
  const logs: LogLine[] = [];
  // Every level, so a line written at the wrong one is still caught and seen.
  const write = (level: string) => (context: Record<string, unknown>, message: string) => {
    logs.push({ level, context, message });
  };
  const log = {
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Where pino-http puts the per-request logger in the real app.
    (req as unknown as { log: unknown }).log = log;
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
      if (options.upstreamError !== undefined) throw options.upstreamError;
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
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
  return { app, captured, logs };
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
          res.on('end', () => {
            // Parsed only when it IS JSON. Express's own error page is HTML, and
            // a JSON.parse throwing inside this handler never settled the
            // promise — so a route answering 500 made its case hang until the
            // timeout instead of failing on the status it got.
            let body: Record<string, unknown> = {};
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                body = { unparsedBody: raw.slice(0, 200) };
              }
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
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

/**
 * THE SAME FAILURES, AS THE OPERATOR SEES THEM.
 *
 * "No hint" is the right answer for the customer and a useless one for the
 * operator, because it looks exactly like an empty queue. These failures were
 * logged at debug, which the default level does not print, so an operator
 * whose pop-ups never arrived had nothing to look at. They warn now — at most
 * once a minute per route, because every page load asks, and an outage would
 * otherwise write one line per customer.
 */
describe('a panel failure the operator can see', () => {
  /** What an older panel answers to a field its DTO has not learned. */
  const REFUSAL = new UpstreamError(
    'POST',
    '/api/internal/user-hints/next',
    400,
    JSON.stringify({
      statusCode: 400,
      message: ['property modes should not exist'],
      error: 'Bad Request',
    }),
  );

  const ROUTES = [
    { path: '/hints/next', body: { surface: 'browser' }, answer: { hint: null } },
    { path: '/hints/moment', body: { moment: 'subscription-ready' }, answer: { raised: false } },
    { path: '/hints/shown', body: { deliveryId: 'del-1' }, answer: { ok: false } },
    {
      path: '/hints/closed',
      body: { deliveryId: 'del-1', outcome: 'acted' },
      answer: { ok: false },
    },
  ] as const;

  it.each(ROUTES)(
    '$path warns with the status and the panel’s own message, and answers exactly as before',
    async ({ path, body, answer }) => {
      const { app, logs } = makeApp({ upstreamError: REFUSAL });

      const res = await postJson(app, `/api/v1${path}`, body);

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual(answer);
      expect(logs.map((line) => line.level)).toEqual(['warn']);
      expect(logs[0].context).toStrictEqual({
        route: path,
        status: 400,
        panelMessage: 'property modes should not exist',
        suppressedSinceLastWarn: 0,
      });
      expect(logs[0].message).toContain('the panel answered 400');
    },
  );

  it('warns at most once a minute per route, then says how many it kept quiet', async () => {
    let now = 1_700_000_000_000;
    const { app, logs } = makeApp({ upstreamError: REFUSAL, now: () => now });
    const askNext = () => postJson(app, '/api/v1/hints/next', { surface: 'browser' });

    await askNext();
    now += 1_000;
    await askNext();
    now += 58_999; // 59 999 ms after the first warning
    await askNext();
    expect(logs, 'warned again inside the minute').toHaveLength(1);

    // Another route keeps a throttle of its own: a flood on one call must not
    // hide the first failure of another.
    await postJson(app, '/api/v1/hints/shown', { deliveryId: 'del-1' });
    expect(logs).toHaveLength(2);
    expect(logs[1].context.route).toBe('/hints/shown');

    now += 1; // exactly a minute after the first warning
    await askNext();
    expect(logs).toHaveLength(3);
    expect(logs[2].level).toBe('warn');
    expect(logs[2].context.route).toBe('/hints/next');
    expect(logs[2].context.suppressedSinceLastWarn).toBe(2);
    expect(logs[2].message).toContain('2 more kept quiet since the last warning');

    // The count is of failures since THAT warning, not since the first.
    now += 60_000;
    await askNext();
    expect(logs).toHaveLength(4);
    expect(logs[3].context.suppressedSinceLastWarn).toBe(0);
  });

  it('names a failure that never got an HTTP answer by its code', async () => {
    // No status to report: the connection was refused, or it timed out. The
    // code is what tells an operator which.
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3000'), {
      code: 'ECONNREFUSED',
    });
    const { app, logs } = makeApp({ upstreamError: refused });

    const res = await postJson(app, '/api/v1/hints/next', { surface: 'browser' });

    expect(res.body).toStrictEqual({ hint: null });
    expect(logs.map((line) => line.level)).toEqual(['warn']);
    expect(logs[0].context).toStrictEqual({
      route: '/hints/next',
      errorCode: 'ECONNREFUSED',
      error: 'Error: connect ECONNREFUSED 10.0.0.5:3000',
      suppressedSinceLastWarn: 0,
    });
    expect(logs[0].message).toContain('the call failed before the panel answered');
  });

  it('still answers exactly “no hint” when the failure itself cannot be described', async () => {
    // The log line is read off the thrown value, and a thrown value can be
    // anything. Reading it runs inside the `catch` that answers the customer,
    // and Express 5 turns a throw from there into a 500 — the line is never
    // worth the page.
    const unreadable = new Proxy(new Error('panel is down'), {
      get(target, property, receiver) {
        if (property === 'code') throw new Error('this error cannot be read');
        return Reflect.get(target, property, receiver);
      },
    });
    const { app } = makeApp({ upstreamError: unreadable });

    const res = await postJson(app, '/api/v1/hints/next', { surface: 'browser' });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ hint: null });
  });

  it('never writes down who the customer is', async () => {
    // The route names the call; the session and the body name the person, and
    // a log line is copied to places a customer's identity has no business in.
    const { app, logs } = makeApp({ userId: 'user-7f3a9c', upstreamError: REFUSAL });

    await postJson(app, '/api/v1/hints/closed', {
      deliveryId: 'del-4b21e0',
      outcome: 'dismissed',
      surface: 'tma',
      initData: 'query_id=AAE&user=%7B%22id%22%3A424242%7D&hash=abc123',
    });

    expect(logs).toHaveLength(1);
    const written = JSON.stringify(logs[0]);
    for (const personal of ['user-7f3a9c', 'del-4b21e0', 'session-1', '424242', 'query_id']) {
      expect(written, `the log line carries ${personal}`).not.toContain(personal);
    }
    expect(Object.keys(logs[0].context).sort()).toEqual([
      'panelMessage',
      'route',
      'status',
      'suppressedSinceLastWarn',
    ]);
  });
});
