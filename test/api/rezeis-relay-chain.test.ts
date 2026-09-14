/**
 * Panel webhook -> cabinet API -> bot listener -> Telegram, with only Telegram
 * faked.
 *
 * The defect this pins lived BETWEEN two files that were each right on their
 * own terms: the bot answered `422` for a channel post Telegram refused, and the
 * webhook router turned every bot 4xx into `200 { dropped: true }`, which the
 * panel records as a delivered card. A spec of either side alone stays green
 * through that, so this one runs the real router against the real listener over
 * real sockets, signed on both hops, and reads the answer the way the panel does
 * (`panel-relay-reading.ts`).
 */
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import express from 'express';
import { GrammyError } from 'grammy';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ReiwaConfig } from '../../src/config.js';
import { createRezeisWebhookRouter } from '../../src/api/routes/webhooks.js';
import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import { captureGrammyFailures, type GrammyFailures } from '../bot/grammy-failures.js';
import {
  BROADCAST_CHANNEL_EVENT_PREFIX,
  panelReading,
  panelRememberedChannelPost,
} from './panel-relay-reading.js';

const WEBHOOK_SECRET = 'webhook-secret';
const INTERNAL_SECRET = 's'.repeat(32);
const DEV_ID = 555000333;

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];
type SendResult = { readonly message_id: number };

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

let idCounter = 0;
function freshEventId(label: string): string {
  idCounter += 1;
  return `relay-chain:${label}:${process.pid}:${Date.now()}:${idCounter}`;
}

/** Real grammY network failures (`grammy-failures.ts`), captured once. */
let failures: GrammyFailures;
beforeAll(async () => {
  failures = await captureGrammyFailures();
}, 20_000);

function telegramError(errorCode: number, description: string, parameters: { readonly retry_after?: number } = {}) {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: errorCode, description, parameters },
    'sendMessage',
    {},
  );
}

interface PanelAnswer {
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly text: string;
}

async function startChain(opts: { readonly devId?: number; readonly botSecret?: string } = {}) {
  const sendMessage = vi.fn(async (..._args: unknown[]): Promise<SendResult> => ({ message_id: 4242 }));
  const sendDocument = vi.fn(async (..._args: unknown[]): Promise<SendResult> => ({ message_id: 4343 }));
  const onUserBlocked = vi.fn(async (_telegramId: string): Promise<void> => {});

  const botServer = startInternalHttpListener({
    bot: { api: { sendMessage, sendDocument } } as unknown as ListenerOptions['bot'],
    cache: null,
    secret: opts.botSecret ?? INTERNAL_SECRET,
    port: 0,
    logger: silentLogger,
    devId: opts.devId,
    onUserBlocked,
  });
  if (botServer === null) throw new Error('listener did not start');
  await once(botServer, 'listening');
  const botPort = (botServer.address() as AddressInfo).port;

  const config = {
    REZEIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    REIWA_BOT_INTERNAL_URL: `http://127.0.0.1:${botPort}`,
    REZEIS_INTERNAL_SHARED_SECRET: INTERNAL_SECRET,
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
  const apiServer = http.createServer(app);
  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const apiPort = (apiServer.address() as AddressInfo).port;

  /** POST one signed webhook exactly as `BotNotifierClient.deliver` builds it. */
  const deliver = async (event: string, metadata: Record<string, unknown>): Promise<PanelAnswer> => {
    const raw = JSON.stringify({ event, category: 'REIWA', severity: 'INFO', message: event, metadata });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    return await new Promise<PanelAnswer>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: apiPort,
          path: '/api/v1/webhooks/rezeis',
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            connection: 'close',
            'x-rezeis-event': event,
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
  };

  const close = async (): Promise<void> => {
    apiServer.closeAllConnections();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    botServer.closeAllConnections();
    await new Promise<void>((resolve) => botServer.close(() => resolve()));
  };

  return { deliver, sendMessage, sendDocument, onUserBlocked, close };
}

describe('relay chain: an operator card Telegram refused', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a refused channel post reaches the panel as undelivered and final, not as posted', async () => {
    const chain = await startChain();
    chain.sendMessage.mockRejectedValueOnce(telegramError(400, 'Bad Request: chat not found'));
    try {
      const answer = await chain.deliver('reiwa.channel.broadcast', {
        eventId: freshEventId('channel-refused'),
        chatId: '-1001234567890',
        text: 'Новый платёж',
      });

      // Anchor: the post really went out to Telegram, to the operator's chat.
      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(chain.sendMessage.mock.calls[0]?.[0]).toBe('-1001234567890');
      expect(answer.status).toBe(422);
      expect(panelReading('reiwa.channel.broadcast', answer)).toEqual({
        status: 'rejected',
        delivered: false,
        retryable: false,
      });
    } finally {
      await chain.close();
    }
  });

  it('a refused error-report document is undelivered too, where it used to be a bare 204', async () => {
    const chain = await startChain();
    chain.sendDocument.mockRejectedValueOnce(
      telegramError(403, 'Forbidden: bot is not a member of the supergroup chat'),
    );
    try {
      const answer = await chain.deliver('reiwa.channel.broadcast.document', {
        eventId: freshEventId('document-refused'),
        chatId: '-1001234567890',
        content: 'full error report',
      });

      expect(chain.sendDocument).toHaveBeenCalledTimes(1);
      expect(answer.status).toBe(422);
      expect(panelReading('reiwa.channel.broadcast.document', answer).delivered).toBe(false);
    } finally {
      await chain.close();
    }
  });
});

describe('relay chain: a Telegram flood-wait', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CASES = [
    {
      event: 'reiwa.channel.broadcast',
      send: 'sendMessage',
      metadata: (eventId: string) => ({ eventId, chatId: '-1001234567890', text: 'Новый платёж' }),
      // Confirmed: a channel post comes back with Telegram's id.
      afterRetry: { status: 'confirmed', delivered: true, retryable: false },
    },
    {
      event: 'reiwa.user.notify',
      send: 'sendMessage',
      metadata: (eventId: string) => ({ eventId, telegramId: '123456789', text: 'Подписка истекает завтра' }),
      afterRetry: { status: 'confirmed', delivered: true, retryable: false },
    },
    {
      event: 'reiwa.dev.notify.document',
      send: 'sendDocument',
      metadata: (eventId: string) => ({ eventId, content: 'full error report', filename: 'error_0.txt' }),
      afterRetry: { status: 'unconfirmed', delivered: true, retryable: false },
    },
  ] as const;

  it.each(CASES)('$event: retried with the wait attached, and the retry is sent rather than deduplicated', async ({ event, send, metadata, afterRetry }) => {
    const chain = await startChain({ devId: DEV_ID });
    const eventId = freshEventId(`flood-${event}`);
    chain[send].mockRejectedValueOnce(
      telegramError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }),
    );
    try {
      const first = await chain.deliver(event, metadata(eventId));

      expect(chain[send]).toHaveBeenCalledTimes(1);
      expect(first.status).toBe(503);
      expect(first.retryAfter).toBe('7');
      expect(panelReading(event, first)).toEqual({ status: 'rejected', delivered: false, retryable: true });

      // BullMQ replays the job payload byte for byte, eventId included.
      const retry = await chain.deliver(event, metadata(eventId));
      expect(chain[send]).toHaveBeenCalledTimes(2);
      expect(panelReading(event, retry)).toEqual(afterRetry);
    } finally {
      await chain.close();
    }
  });
});

describe('relay chain: the dev fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('without BOT_DEV_ID the panel hears 424 instead of a delivered card', async () => {
    const chain = await startChain();
    try {
      for (const [event, metadata] of [
        ['reiwa.dev.notify', { eventId: freshEventId('no-dev'), text: '<b>Сбой</b>', parseMode: 'HTML' }],
        ['reiwa.dev.notify.document', { eventId: freshEventId('no-dev-doc'), content: 'report' }],
      ] as const) {
        const answer = await chain.deliver(event, metadata);
        expect(answer.status, event).toBe(424);
        expect(panelReading(event, answer), event).toEqual({ status: 'rejected', delivered: false, retryable: false });
      }
      expect(chain.sendMessage).not.toHaveBeenCalled();
      expect(chain.sendDocument).not.toHaveBeenCalled();
    } finally {
      await chain.close();
    }
  });

  it('a dev card Telegram refused is undelivered and final; a report whose connection was refused is retried and then sent', async () => {
    const chain = await startChain({ devId: DEV_ID });
    chain.sendMessage.mockRejectedValueOnce(telegramError(400, 'Bad Request: chat not found'));
    // Refused before a request existed: no report can be in the chat, so the
    // retry has to send it.
    chain.sendDocument.mockRejectedValueOnce(failures.refused);
    try {
      const card = await chain.deliver('reiwa.dev.notify', { eventId: freshEventId('dev-refused'), text: 'карточка' });
      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(card.status).toBe(422);
      expect(panelReading('reiwa.dev.notify', card).delivered).toBe(false);

      const reportId = freshEventId('dev-network');
      const report = await chain.deliver('reiwa.dev.notify.document', { eventId: reportId, content: 'отчёт' });
      expect(chain.sendDocument).toHaveBeenCalledTimes(1);
      expect(report.status).toBe(502);
      expect(panelReading('reiwa.dev.notify.document', report).retryable).toBe(true);

      const retried = await chain.deliver('reiwa.dev.notify.document', { eventId: reportId, content: 'отчёт' });
      expect(chain.sendDocument).toHaveBeenCalledTimes(2);
      expect(panelReading('reiwa.dev.notify.document', retried).delivered).toBe(true);
    } finally {
      await chain.close();
    }
  });
});

/**
 * A send that failed AFTER its request may have reached Telegram — here, a
 * connection reset once the whole request was written.
 *
 * Retried, and really sent again. The bot used to hold such an event and answer
 * its retry `200 { messageId: null }` without sending — `unconfirmed`, which
 * the panel records as DELIVERED for every event but a user notification — so
 * an operator card or a channel post that failed this way was recorded as
 * posted, with nothing sent, no retry left and no alert. At least once instead:
 * the price is a second copy on the rare occasion Telegram did take the first.
 */
describe('relay chain: a send that failed after its request left', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CASES = [
    {
      event: 'reiwa.user.notify',
      send: 'sendMessage',
      metadata: (eventId: string) => ({ eventId, telegramId: '123456789', text: 'Подписка истекает завтра' }),
      afterRetry: { status: 'confirmed', delivered: true, retryable: false },
    },
    {
      event: 'reiwa.channel.broadcast',
      send: 'sendMessage',
      metadata: (eventId: string) => ({
        eventId: `${BROADCAST_CHANNEL_EVENT_PREFIX}${eventId}`,
        chatId: '-1001234567890',
        text: 'Новый платёж',
      }),
      afterRetry: { status: 'confirmed', delivered: true, retryable: false },
    },
    {
      // A document route answers a delivery with a bodiless 204: `unconfirmed`,
      // which is delivered for this event.
      event: 'reiwa.dev.notify.document',
      send: 'sendDocument',
      metadata: (eventId: string) => ({ eventId, content: 'full error report', filename: 'error_0.txt' }),
      afterRetry: { status: 'unconfirmed', delivered: true, retryable: false },
    },
  ] as const;

  it.each(CASES)('$event: retried, and the retry is sent and read as delivered', async ({ event, send, metadata, afterRetry }) => {
    const chain = await startChain({ devId: DEV_ID });
    const payload = metadata(freshEventId(`failed-after-send-${event}`));
    chain[send].mockRejectedValueOnce(failures.resetAfterRequest).mockResolvedValueOnce({ message_id: 8801 });
    try {
      const first = await chain.deliver(event, payload);
      expect(chain[send]).toHaveBeenCalledTimes(1);
      expect(first.status).toBe(502);
      expect(panelReading(event, first)).toEqual({ status: 'rejected', delivered: false, retryable: true });

      const retry = await chain.deliver(event, payload);
      expect(chain[send]).toHaveBeenCalledTimes(2);
      expect(panelReading(event, retry)).toEqual(afterRetry);
      if (afterRetry.status === 'confirmed') expect(JSON.parse(retry.text)).toEqual({ messageId: 8801 });
      // A channel post keeps the address of the copy the retry posted.
      if (event === 'reiwa.channel.broadcast') {
        expect(panelRememberedChannelPost(event, payload, retry)?.channelMessageId).toBe(8801n);
      }
    } finally {
      await chain.close();
    }
  });
});

describe('relay chain: a subscriber who blocked the bot, and a panel slow to record it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is still answered inside the relay deadline, terminal and quiet, when marking them blocked hangs', async () => {
    // Real budgets on both sides: this router gives the hop 8s, and the bot
    // waits for `onUserBlocked` — a call to the panel, whose transport waits up
    // to 10s for headers — no longer than its cap. Unbounded, a slow panel
    // turned this answer into the deadline's 502: retried (another send to a
    // subscriber who blocked the bot), alerted, and counted toward broadcast
    // delivery's relay circuit breaker.
    const chain = await startChain();
    const marking: { finish?: () => void } = {};
    chain.onUserBlocked.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          marking.finish = resolve;
        }),
    );
    chain.sendMessage.mockRejectedValueOnce(telegramError(403, 'Forbidden: bot was blocked by the user'));
    try {
      const startedAt = performance.now();
      const answer = await chain.deliver('reiwa.user.notify', {
        eventId: freshEventId('blocked-slow-panel'),
        telegramId: '123456789',
        text: 'Подписка истекает завтра',
      });
      const elapsed = performance.now() - startedAt;

      expect(answer.status).toBe(200);
      expect(panelReading('reiwa.user.notify', answer)).toEqual({
        status: 'unconfirmed',
        delivered: false,
        retryable: false,
      });
      expect(chain.onUserBlocked).toHaveBeenCalledWith('123456789');
      // The bot gave the panel its chance to record the block before answering…
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      // …and answered long before the hop's 8s.
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      marking.finish?.();
      await chain.close();
    }
  }, 20_000);
});

/**
 * The bot delivered and said so, and its answer was lost on the way back — the
 * body of the bot's 200 could not be read.
 *
 * For the two events whose message id the panel keeps, this router asks for a
 * retry rather than answering `{ messageId: null }`: the bot recorded the id
 * against the event BEFORE answering, and a replay of a delivered event is
 * answered with that id and sends nothing. So the retry recovers the proof;
 * `null` would have filed a delivered notification as undelivered, and a
 * channel post as unaddressable, for good.
 */
describe('relay chain: an unreadable answer to a delivered message', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CASES = [
    {
      event: 'reiwa.user.notify',
      metadata: (eventId: string) => ({ eventId, telegramId: '123456789', text: 'Подписка истекает завтра' }),
    },
    {
      event: 'reiwa.channel.broadcast',
      metadata: (eventId: string) => ({
        eventId: `${BROADCAST_CHANNEL_EVENT_PREFIX}${eventId}`,
        chatId: '-1001234567890',
        text: 'Новый платёж',
      }),
    },
  ] as const;

  it.each(CASES)('$event: is retried, and the retry brings back the real message id without a second send', async ({ event, metadata }) => {
    const chain = await startChain();
    chain.sendMessage.mockResolvedValueOnce({ message_id: 9901 });
    const payload = metadata(freshEventId(`unreadable-${event}`));
    const realFetch = globalThis.fetch;
    // The router's call to the bot goes through for real; only the body of the
    // bot's answer is lost, after the bot has already delivered and answered.
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input, init) => {
      const real = await realFetch(input, init);
      await real.arrayBuffer();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('connection reset while reading the body'));
          },
        }),
        { status: real.status, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      const first = await chain.deliver(event, payload);
      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(first.status).toBe(502);
      expect(panelReading(event, first)).toEqual({ status: 'rejected', delivered: false, retryable: true });

      const retry = await chain.deliver(event, payload);
      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(JSON.parse(retry.text)).toEqual({ messageId: 9901 });
      expect(panelReading(event, retry)).toEqual({ status: 'confirmed', delivered: true, retryable: false });
    } finally {
      await chain.close();
    }
  });
});

describe('relay chain: a backup the bot could not prove', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not a delivered backup for the panel — BackupService demands a message id', async () => {
    // This bot has no rezeis URL, so it answers the backup relay 204: nothing
    // uploaded. The panel's `BackupService` accepts only `confirmed`; reading
    // this `unconfirmed` as delivered would stamp a local-only backup off-site.
    const chain = await startChain();
    try {
      const answer = await chain.deliver('reiwa.backup.document', {
        recordId: 'ckbackup0001',
        token: 'signed-download-token',
        chatId: '-1001234567890',
      });
      expect(chain.sendDocument).not.toHaveBeenCalled();
      expect(JSON.parse(answer.text)).toEqual({ messageId: null });
      expect(panelReading('reiwa.backup.document', answer)).toEqual({
        status: 'unconfirmed',
        delivered: false,
        retryable: false,
      });
    } finally {
      await chain.close();
    }
  });
});

describe('relay chain: what did not change', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a subscriber who blocked the bot stays the terminal, un-retried, undelivered outcome', async () => {
    const chain = await startChain();
    chain.sendMessage.mockRejectedValueOnce(telegramError(403, 'Forbidden: bot was blocked by the user'));
    try {
      const answer = await chain.deliver('reiwa.user.notify', {
        eventId: freshEventId('blocked'),
        telegramId: '123456789',
        text: 'Подписка истекает завтра',
      });

      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ messageId: null });
      // `unconfirmed` on a user notification: the panel completes the job with
      // `delivered: false` and raises no alert (`shouldAlertOperator`).
      expect(panelReading('reiwa.user.notify', answer)).toEqual({
        status: 'unconfirmed',
        delivered: false,
        retryable: false,
      });
      expect(chain.onUserBlocked).toHaveBeenCalledWith('123456789');
    } finally {
      await chain.close();
    }
  });

  it('a delivered channel post is still delivered', async () => {
    const chain = await startChain();
    try {
      const answer = await chain.deliver('reiwa.channel.broadcast', {
        eventId: freshEventId('delivered'),
        chatId: '@my_channel',
        text: 'Всем привет',
      });
      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(panelReading('reiwa.channel.broadcast', answer).delivered).toBe(true);
    } finally {
      await chain.close();
    }
  });

  it('an internal-secret mismatch between the two containers is a retryable failure, not a delivery', async () => {
    const chain = await startChain({ botSecret: 't'.repeat(32) });
    try {
      const answer = await chain.deliver('reiwa.channel.broadcast', {
        eventId: freshEventId('secret-drift'),
        chatId: '-1001234567890',
        text: 'Новый платёж',
      });
      expect(chain.sendMessage).not.toHaveBeenCalled();
      expect(answer.status).toBe(502);
      expect(panelReading('reiwa.channel.broadcast', answer)).toEqual({
        status: 'rejected',
        delivered: false,
        retryable: true,
      });
    } finally {
      await chain.close();
    }
  });
});

/**
 * A broadcast's channel post has to come back with its ADDRESS.
 *
 * Telegram has no "what did I post" call, so the message id in the bot's reply
 * is the only moment the panel can learn where a broadcast's public copy lives.
 * The panel keeps it (`rememberChannelPost`), and its channel edit and recall
 * work from nothing else. The bot echoed the id; this router answered the event
 * with a bodiless 204 anyway — `unconfirmed`, no id — so every broadcast's
 * channel copy was stored as unaddressable, and editing or recalling the
 * broadcast left the public post untouched.
 *
 * The copy is always one text `sendMessage` (the relay contract carries no
 * media), so there is exactly one id to carry.
 */
describe("relay chain: a broadcast's channel post keeps its address", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The metadata `postToChannelIfConfigured` enqueues for one broadcast. */
  function channelPost(broadcastId: string) {
    return {
      eventId: `${BROADCAST_CHANNEL_EVENT_PREFIX}${broadcastId}`,
      chatId: '-1001234567890',
      text: '<b>Скидка 20%</b>\n\nТолько до пятницы',
      parseMode: 'HTML',
    } as const;
  }

  it('reaches the panel confirmed with Telegram’s message id, which the panel keeps as the post’s address', async () => {
    const chain = await startChain();
    chain.sendMessage.mockResolvedValueOnce({ message_id: 7781 });
    const broadcastId = freshEventId('channel-address');
    const metadata = channelPost(broadcastId);
    try {
      const answer = await chain.deliver('reiwa.channel.broadcast', metadata);

      // Anchor: one real post, to the operator's channel.
      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(chain.sendMessage.mock.calls[0]?.[0]).toBe('-1001234567890');
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ messageId: 7781 });
      expect(panelReading('reiwa.channel.broadcast', answer)).toEqual({
        status: 'confirmed',
        delivered: true,
        retryable: false,
      });
      expect(panelRememberedChannelPost('reiwa.channel.broadcast', metadata, answer)).toEqual({
        broadcastId,
        channelChatId: '-1001234567890',
        channelMessageId: 7781n,
      });
    } finally {
      await chain.close();
    }
  });

  it('a replay of a post that already went out answers the same address and posts nothing twice', async () => {
    // The cabinet gave up on the hop after its deadline while Telegram was
    // still answering, so the panel retries a post that DID go out. The replay
    // must not post again — and must still hand back the address, or the panel
    // stores nothing for the one copy it cannot find by itself.
    const chain = await startChain();
    chain.sendMessage.mockResolvedValueOnce({ message_id: 7782 });
    const metadata = channelPost(freshEventId('channel-replay'));
    try {
      const first = await chain.deliver('reiwa.channel.broadcast', metadata);
      const replay = await chain.deliver('reiwa.channel.broadcast', metadata);

      expect(chain.sendMessage).toHaveBeenCalledTimes(1);
      expect(panelRememberedChannelPost('reiwa.channel.broadcast', metadata, first)?.channelMessageId).toBe(7782n);
      expect(panelRememberedChannelPost('reiwa.channel.broadcast', metadata, replay)?.channelMessageId).toBe(7782n);
    } finally {
      await chain.close();
    }
  });
});
