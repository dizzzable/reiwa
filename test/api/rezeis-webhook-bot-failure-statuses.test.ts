/**
 * What the webhook tells the panel when the BOT could not deliver.
 *
 * The cabinet API is a translator between two contracts. The bot answers it in
 * statuses (`internal-http-listener.ts`); the panel reads the webhook's answer
 * with rules of its own and acts on them. This file pins the translation, and
 * reads every answer the way the panel does, so a regression shows up in the
 * panel's words — "recorded as delivered", "never retried" — rather than as a
 * bare number.
 *
 * The defect this exists for: the bot answered `422` for a channel post
 * Telegram refused, and this router rewrote EVERY bot 4xx to
 * `200 { dropped: true }`. The panel files a 2xx without a message id as
 * `unconfirmed`, and counts `unconfirmed` as delivered for every event except a
 * user notification — so an operator card that never reached Telegram was
 * recorded as posted, with no alert and no retry.
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReiwaConfig } from '../../src/config.js';
import { createRezeisWebhookRouter } from '../../src/api/routes/webhooks.js';
import { panelReading } from './panel-relay-reading.js';

const WEBHOOK_SECRET = 'webhook-secret';

function buildApp(): express.Express {
  const config = {
    REZEIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    REIWA_BOT_INTERNAL_URL: 'http://reiwa-bot:5100',
    REZEIS_INTERNAL_SHARED_SECRET: 's'.repeat(32),
  } satisfies Pick<ReiwaConfig, 'REZEIS_WEBHOOK_SECRET' | 'REIWA_BOT_INTERNAL_URL' | 'REZEIS_INTERNAL_SHARED_SECRET'>;
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as { rawBody?: Buffer }).rawBody = buffer;
      },
    }),
  );
  app.use('/api/v1', createRezeisWebhookRouter({ config: config as unknown as ReiwaConfig }));
  return app;
}

interface WebhookAnswer {
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly text: string;
  /** The bot path the router dialled, or `null` when it never got that far. */
  readonly relayedTo: string | null;
}

/**
 * A bot answer whose body cannot be read: the connection died mid-body, or
 * what arrived is not the JSON the bot writes.
 */
type UnreadableBody = 'reset-mid-body' | 'truncated-json';

function unreadableBody(kind: UnreadableBody): BodyInit {
  if (kind === 'truncated-json') return '{"messageId": 42';
  return new ReadableStream({
    start(controller) {
      controller.error(new Error('connection reset while reading the body'));
    },
  });
}

/** Deliver one signed webhook while the "bot" answers `botStatus` (+ headers/body). */
async function deliver(
  event: string,
  metadata: Record<string, unknown>,
  bot: {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
    readonly unreadable?: UnreadableBody;
  },
): Promise<WebhookAnswer> {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    bot.unreadable !== undefined
      ? new Response(unreadableBody(bot.unreadable), {
          status: bot.status,
          headers: { 'content-type': 'application/json', ...bot.headers },
        })
      : new Response(bot.body === undefined ? null : JSON.stringify(bot.body), {
          status: bot.status,
          headers: { ...(bot.body === undefined ? {} : { 'content-type': 'application/json' }), ...bot.headers },
        }),
  );
  const server = http.createServer(buildApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const raw = JSON.stringify({ event, metadata });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
  try {
    const answer = await new Promise<Omit<WebhookAnswer, 'relayedTo'>>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/webhooks/rezeis',
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            connection: 'close',
            'x-rezeis-signature': `t=${timestamp},v1=${signature}`,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => {
            const header = res.headers['retry-after'];
            resolve({ status: res.statusCode ?? 0, retryAfter: Array.isArray(header) ? header[0] : header, text });
          });
        },
      );
      req.on('error', reject);
      req.end(raw);
    });
    const firstCall = fetchMock.mock.calls[0];
    return { ...answer, relayedTo: firstCall === undefined ? null : String(firstCall[0]) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fetchMock.mockRestore();
  }
}

/** One well-formed webhook per event that relays to a Telegram send. */
const NOTIFY_EVENTS = [
  {
    event: 'reiwa.channel.broadcast',
    path: '/notify-broadcast',
    metadata: { eventId: 'evt-broadcast', chatId: '-1001234567890', text: 'Новый платёж' },
  },
  {
    event: 'reiwa.channel.broadcast.document',
    path: '/notify-broadcast-document',
    metadata: { eventId: 'evt-broadcast-doc', chatId: '-1001234567890', content: 'full error report' },
  },
  {
    event: 'reiwa.dev.notify',
    path: '/notify-dev',
    metadata: { eventId: 'sysevt:test:dev', text: '<b>Сбой</b>', parseMode: 'HTML' },
  },
  {
    event: 'reiwa.dev.notify.document',
    path: '/notify-dev-document',
    metadata: { eventId: 'sysevt:test:dev-doc', content: 'full error report', filename: 'error_0.txt' },
  },
  {
    event: 'reiwa.user.notify',
    path: '/notify',
    metadata: { eventId: 'evt-user', telegramId: '123456789', text: 'Подписка истекает завтра' },
  },
] as const;

describe('webhook: the bot says Telegram refused the message (422)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(NOTIFY_EVENTS)('$event is answered 422 — undelivered and final for the panel, not 200 { dropped: true }', async ({ event, path, metadata }) => {
    const answer = await deliver(event, metadata, {
      status: 422,
      body: { error: 'Bad Request: chat not found' },
    });

    // Anchor: the relay really reached the bot; a 400 from our own validation
    // would satisfy "not 2xx" for a reason that has nothing to do with this.
    expect(answer.relayedTo).toBe(`http://reiwa-bot:5100${path}`);
    expect(answer.status).toBe(422);
    expect(answer.text).not.toContain('dropped');
    expect(panelReading(event, answer)).toEqual({ status: 'rejected', delivered: false, retryable: false });
    // Telegram's own words go along, for whoever reads the answer.
    expect(JSON.parse(answer.text)).toMatchObject({ detail: 'Bad Request: chat not found' });
  });
});

describe('webhook: the bot has no dev recipient (424)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(NOTIFY_EVENTS.filter(({ event }) => event.startsWith('reiwa.dev.')))(
    '$event is answered 424 — distinguishable from a Telegram refusal, and not delivered',
    async ({ event, path, metadata }) => {
      const answer = await deliver(event, metadata, {
        status: 424,
        body: { error: 'BOT_DEV_ID is not configured' },
      });

      expect(answer.relayedTo).toBe(`http://reiwa-bot:5100${path}`);
      expect(answer.status).toBe(424);
      expect(panelReading(event, answer)).toEqual({ status: 'rejected', delivered: false, retryable: false });
    },
  );
});

describe('webhook: the bot asks to be tried again later', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(NOTIFY_EVENTS)('$event forwards a named wait as 503 + Retry-After — retried by the panel', async ({ event, path, metadata }) => {
    const answer = await deliver(event, metadata, { status: 503, headers: { 'Retry-After': '7' } });

    expect(answer.relayedTo).toBe(`http://reiwa-bot:5100${path}`);
    expect(answer.status).toBe(503);
    expect(answer.retryAfter).toBe('7');
    expect(panelReading(event, answer)).toEqual({ status: 'rejected', delivered: false, retryable: true });
  });

  it('does not forward a Retry-After that is not a plain number of seconds', async () => {
    const answer = await deliver('reiwa.channel.broadcast', NOTIFY_EVENTS[0].metadata, {
      status: 503,
      headers: { 'Retry-After': 'soon, maybe' },
    });

    expect(answer.retryAfter).toBeUndefined();
    expect(panelReading('reiwa.channel.broadcast', answer).retryable).toBe(true);
  });
});

/**
 * The bot answered 200, and its body could not be read.
 *
 * Which answer is safe depends on what the bot does with a retry of the event,
 * and that differs by route:
 *
 *  - `/notify` and `/notify-broadcast` record Telegram's id against the event
 *    before they answer, and answer a replay of a delivered event with that id
 *    without sending (the chain spec, "an unreadable answer to a delivered
 *    message", runs it end to end). A 502 costs one retry and recovers the id;
 *    `{ messageId: null }` loses it for good — a delivered notification filed
 *    as undelivered, a channel post nobody can edit or recall.
 *  - `/notify-backup-document` records nothing. A 502 there is retried by
 *    `BackupService` as a second download and a second upload of the same
 *    backup, so it stays `{ messageId: null }`: local-only, alerted, never
 *    retried.
 *  - the rest answer 204 whatever the bot's body says: nothing reads an id.
 */
describe("webhook: the bot delivered, but its answer's body could not be read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ID_EVENTS = NOTIFY_EVENTS.filter(({ event }) => event === 'reiwa.user.notify' || event === 'reiwa.channel.broadcast');

  for (const unreadable of ['reset-mid-body', 'truncated-json'] as const) {
    it.each(ID_EVENTS)(`$event (${unreadable}) is answered 502 — retried, not recorded without its id`, async ({ event, path, metadata }) => {
      const answer = await deliver(event, metadata, { status: 200, unreadable });

      expect(answer.relayedTo).toBe(`http://reiwa-bot:5100${path}`);
      expect(answer.status).toBe(502);
      expect(panelReading(event, answer)).toEqual({ status: 'rejected', delivered: false, retryable: true });
    });

    it(`reiwa.backup.document (${unreadable}) stays { messageId: null } — the bot keeps no record a retry could be answered from`, async () => {
      const answer = await deliver(
        'reiwa.backup.document',
        { recordId: 'ckbackup0001', token: 'signed-download-token', chatId: '-1001234567890' },
        { status: 200, unreadable },
      );

      expect(answer.relayedTo).toBe('http://reiwa-bot:5100/notify-backup-document');
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ messageId: null });
      expect(panelReading('reiwa.backup.document', answer)).toEqual({
        status: 'unconfirmed',
        delivered: false,
        retryable: false,
      });
    });
  }

  it.each(NOTIFY_EVENTS.filter(({ event }) => !ID_EVENTS.some((idEvent) => idEvent.event === event)))(
    '$event stays the delivered 204 — nothing reads an id for it',
    async ({ event, path, metadata }) => {
      const answer = await deliver(event, metadata, { status: 200, unreadable: 'reset-mid-body' });

      expect(answer.relayedTo).toBe(`http://reiwa-bot:5100${path}`);
      expect(answer.status).toBe(204);
    },
  );
});

describe('webhook: the bot refused or failed the relay itself', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 400/413: the bot will not take the relay body; 401: the two containers
  // disagree about the internal secret; 404: a bot image older than the route.
  // None of them sent anything to Telegram, so a retry cannot duplicate a
  // message, and most of them (a half-restarted pair, a staggered deploy) heal
  // inside the panel's retry window. A 2xx would record them as delivered.
  for (const botStatus of [400, 401, 404, 413, 500, 502, 503]) {
    it(`bot ${botStatus} is a 502 for every notify event — never a 2xx`, async () => {
      for (const { event, path, metadata } of NOTIFY_EVENTS) {
        const answer = await deliver(event, metadata, { status: botStatus });

        expect(answer.relayedTo, event).toBe(`http://reiwa-bot:5100${path}`);
        expect(answer.status, event).toBe(502);
        expect(panelReading(event, answer), event).toEqual({ status: 'rejected', delivered: false, retryable: true });
      }
    });
  }
});
