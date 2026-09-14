/**
 * What the bot's notify routes answer when Telegram does NOT take the message.
 *
 * The status is the only thing that crosses back to the panel, and the panel
 * acts on it (`rezeis-admin`, `backup-delivery-retry.util.ts` and
 * `reiwa-relay.policy.ts`): a 2xx on a non-user event is recorded as DELIVERED,
 * a 5xx/408/429 is retried, any other 4xx is terminal and undelivered —
 * alerted, except on a dev route, where a 424 or a 422 is a dead end the panel
 * completes quietly (`isDevRelayDeadEnd`). So every failure below has exactly
 * one honest answer:
 *
 *   - Telegram refused (4xx that a retry cannot change)   -> 422
 *   - Telegram asked for a wait (429 + `retry_after`)     -> 503 + Retry-After
 *   - Telegram 5xx, a network failure, anything else      -> 502
 *   - dev route, but the bot has no `BOT_DEV_ID`          -> 424
 *   - a subscriber who blocked the bot / never started it -> 204 (`/notify`
 *     only: the panel's terminal, un-alerted per-recipient outcome)
 *
 * and every one of those failures gives the event's idempotency claim BACK, so
 * the panel's retry of the same eventId is really sent. Held, it would be
 * answered as a replay with nothing sent — which for every event but a user
 * notification the panel records as DELIVERED. At least once, then: a failure
 * after Telegram already took the message costs a second copy, and that is the
 * price, not a message nobody receives and nobody is told about.
 *
 * Measured on the grammY call count, not only on the status: a replay and a
 * real send can answer alike. The network failures are real grammY errors
 * (`grammy-failures.ts`), not hand-built shapes.
 *
 * Real listener, real socket, real internal-HMAC headers; only `bot.api` is a
 * stub.
 */
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import { GrammyError } from 'grammy';
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';
import { captureGrammyFailures, type GrammyFailures } from './grammy-failures.js';

const SECRET = 's'.repeat(32);
const DEV_ID = 555000222;

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

/** The idempotency cache is a module singleton: never reuse an id across cases. */
let idCounter = 0;
function freshEventId(label: string): string {
  idCounter += 1;
  return `failure-status:${label}:${process.pid}:${Date.now()}:${idCounter}`;
}

/** A Bot API refusal exactly as grammY raises it. */
function telegramError(
  errorCode: number,
  description: string,
  parameters: { readonly retry_after?: number; readonly migrate_to_chat_id?: number } = {},
): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: errorCode, description, parameters },
    'sendMessage',
    {},
  );
}

/** Captured once: producing them takes grammY's one-second minimum deadline. */
let failures: GrammyFailures;
beforeAll(async () => {
  failures = await captureGrammyFailures();
}, 20_000);

interface Answer {
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly text: string;
}

type SendResult = { readonly message_id: number };

interface Harness {
  readonly call: (path: string, body: Record<string, unknown>) => Promise<Answer>;
  readonly sendMessage: Mock<(...args: unknown[]) => Promise<SendResult>>;
  readonly sendDocument: Mock<(...args: unknown[]) => Promise<SendResult>>;
  readonly sendPhoto: Mock<(...args: unknown[]) => Promise<SendResult>>;
  readonly onUserBlocked: Mock<(telegramId: string) => Promise<void>>;
  readonly close: () => Promise<void>;
}

function startHarness(
  opts: {
    readonly devId?: number;
    readonly withBot?: boolean;
    readonly logger?: ListenerOptions['logger'];
    readonly rezeisAdminUrl?: string;
  } = {},
): Harness {
  const sendMessage = vi.fn(async (..._args: unknown[]): Promise<SendResult> => ({ message_id: 101 }));
  const sendDocument = vi.fn(async (..._args: unknown[]): Promise<SendResult> => ({ message_id: 202 }));
  const sendPhoto = vi.fn(async (..._args: unknown[]): Promise<SendResult> => ({ message_id: 303 }));
  const onUserBlocked = vi.fn(async (_telegramId: string): Promise<void> => {});
  const bot =
    opts.withBot === false
      ? null
      : ({ api: { sendMessage, sendDocument, sendPhoto } } as unknown as ListenerOptions['bot']);

  const server = startInternalHttpListener({
    bot,
    cache: null,
    secret: SECRET,
    port: 0,
    logger: opts.logger ?? silentLogger,
    devId: opts.devId,
    onUserBlocked,
    ...(opts.rezeisAdminUrl !== undefined ? { rezeisAdminUrl: opts.rezeisAdminUrl } : {}),
  });
  if (server === null) throw new Error('listener did not start');
  const ready = once(server, 'listening');

  const call = async (path: string, body: Record<string, unknown>): Promise<Answer> => {
    await ready;
    const { port } = server.address() as { port: number };
    const raw = JSON.stringify(body);
    const { timestamp, signature } = buildInternalSignature({ secret: SECRET, method: 'POST', path, body: raw });
    return await new Promise<Answer>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            connection: 'close',
            [REQUEST_TIMESTAMP_HEADER]: timestamp,
            [REQUEST_SIGNATURE_HEADER]: signature,
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
            resolve({
              status: res.statusCode ?? 0,
              retryAfter: Array.isArray(header) ? header[0] : header,
              text,
            });
          });
        },
      );
      req.on('error', reject);
      req.end(raw);
    });
  };

  const close = async (): Promise<void> => {
    await ready;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { call, sendMessage, sendDocument, sendPhoto, onUserBlocked, close };
}

interface RouteCase {
  readonly path: string;
  readonly send: 'sendMessage' | 'sendDocument';
  /** The status this route answers for a delivered send, and for a replay of one. */
  readonly delivered: number;
  readonly body: (eventId: string) => Record<string, unknown>;
  /** A refusal of THIS route's target that no retry can change. */
  readonly refusal: string;
}

const ROUTES: readonly RouteCase[] = [
  {
    path: '/notify',
    send: 'sendMessage',
    delivered: 200,
    body: (eventId) => ({ eventId, telegramId: '123456789', text: 'Подписка истекает завтра' }),
    // Not "chat not found": for a subscriber that is a per-recipient fact, pinned
    // separately below. A message Telegram will not take is the template's fault.
    refusal: 'Bad Request: message is too long',
  },
  {
    path: '/notify-broadcast',
    send: 'sendMessage',
    delivered: 200,
    body: (eventId) => ({ eventId, chatId: '-1001234567890', text: 'Новый платёж' }),
    refusal: 'Bad Request: chat not found',
  },
  {
    path: '/notify-broadcast-document',
    send: 'sendDocument',
    delivered: 204,
    body: (eventId) => ({ eventId, chatId: '-1001234567890', content: 'full error report' }),
    refusal: 'Forbidden: bot is not a member of the supergroup chat',
  },
  {
    path: '/notify-dev',
    send: 'sendMessage',
    delivered: 204,
    body: (eventId) => ({ eventId, text: '<b>Сбой</b> очереди', parseMode: 'HTML' }),
    refusal: 'Bad Request: chat not found',
  },
  {
    path: '/notify-dev-document',
    send: 'sendDocument',
    delivered: 204,
    body: (eventId) => ({ eventId, content: 'full error report', filename: 'error_0.txt' }),
    refusal: 'Forbidden: bot was blocked by the user',
  },
];

describe('bot notify routes — a Telegram flood-wait', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(ROUTES)('$path: asks for a retry with Retry-After and gives the claim back', async (route) => {
    const harness = startHarness({ devId: DEV_ID });
    const send = harness[route.send];
    const eventId = freshEventId(`flood${route.path}`);
    send.mockRejectedValueOnce(telegramError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }));
    try {
      const first = await harness.call(route.path, route.body(eventId));

      // Anchor: the send really was attempted, so this is the failure path.
      expect(send).toHaveBeenCalledTimes(1);
      // Retryable on the panel's side (5xx), and the wait Telegram named travels.
      expect(first.status).toBe(503);
      expect(first.retryAfter).toBe('7');

      // The panel's retry of the SAME event. Swallowed as a replay, it would
      // answer without sending anything.
      const retry = await harness.call(route.path, route.body(eventId));
      expect(send).toHaveBeenCalledTimes(2);
      expect(retry.status).toBe(route.delivered);
    } finally {
      await harness.close();
    }
  });
});

describe('bot notify routes — any other failed send', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Every one of these gives the claim back and the panel's retry is really
  // sent — including the ones that can happen AFTER Telegram took the message
  // (the request was written, and a reset, silence, an HTML page or a 5xx came
  // back), where the retry is a second copy. Holding those instead answered the
  // retry "unconfirmed": delivered, for every event but a user notification, so
  // a Bot API behind a proxy answering HTML 502 had every operator card
  // recorded as posted, none sent, and nobody alerted.
  const FAILURES = [
    { label: 'a refused connection', error: () => failures.refused },
    { label: 'a connection reset after the request was written', error: () => failures.resetAfterRequest },
    { label: 'grammY timing out on a held request', error: () => failures.timedOut },
    { label: 'an HTML 502 in front of the Bot API', error: () => failures.htmlBadGateway },
    { label: 'a Telegram 5xx', error: () => failures.serverError },
    { label: 'a Telegram 502', error: () => telegramError(502, 'Bad Gateway') },
  ] as const;

  it('anchor: all but the refused connection reached the server — the second copy they can cost is real', () => {
    expect(failures.requestsReceived).toEqual({
      resetAfterRequest: 1,
      htmlBadGateway: 1,
      timedOut: 1,
      serverError: 1,
    });
  });

  for (const { label, error } of FAILURES) {
    it.each(ROUTES)(`$path: ${label} answers 502, and the retry is really sent`, async (route) => {
      const harness = startHarness({ devId: DEV_ID });
      const send = harness[route.send];
      const eventId = freshEventId(`failed${route.path}`);
      send.mockRejectedValueOnce(error()).mockResolvedValueOnce({ message_id: 909 });
      try {
        const first = await harness.call(route.path, route.body(eventId));
        expect(send).toHaveBeenCalledTimes(1);
        expect(first.status).toBe(502);

        const retry = await harness.call(route.path, route.body(eventId));
        expect(send).toHaveBeenCalledTimes(2);
        expect(retry.status).toBe(route.delivered);
        // The retry's own proof: Telegram's id for the message it sent.
        if (route.delivered === 200) expect(JSON.parse(retry.text)).toEqual({ messageId: 909 });
      } finally {
        await harness.close();
      }
    });
  }
});

describe('bot /notify — a banner never costs the notification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const notification = (label: string, bannerUrl: string) => ({
    eventId: freshEventId(label),
    telegramId: '123456789',
    text: 'Подписка истекает завтра',
    bannerUrl,
  });

  it('a banner photo that failed falls back to text', async () => {
    const harness = startHarness();
    harness.sendPhoto.mockRejectedValueOnce(failures.resetAfterRequest);
    try {
      // Absolute: the resolver hands it to Telegram as is, no download here.
      const answer = await harness.call('/notify', notification('photo-failed', 'https://cdn.example.com/banner.jpg'));
      expect(harness.sendPhoto).toHaveBeenCalledTimes(1);
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ messageId: 101 });
    } finally {
      await harness.close();
    }
  });

  it('when the text fallback fails too, the retry is sent in full', async () => {
    // The photo may be in the chat already; the retry sends it again rather
    // than answer for a notification nobody can prove arrived.
    const harness = startHarness();
    harness.sendPhoto.mockRejectedValueOnce(failures.resetAfterRequest);
    harness.sendMessage.mockRejectedValueOnce(failures.refused);
    const body = notification('photo-and-text-failed', 'https://cdn.example.com/banner.jpg');
    try {
      const first = await harness.call('/notify', body);
      expect(harness.sendPhoto).toHaveBeenCalledTimes(1);
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(first.status).toBe(502);

      const retry = await harness.call('/notify', body);
      expect(harness.sendPhoto).toHaveBeenCalledTimes(2);
      expect(retry.status).toBe(200);
      expect(JSON.parse(retry.text)).toEqual({ messageId: 303 });
    } finally {
      await harness.close();
    }
  });

  it('a banner upload whose download dies mid-body is dropped, and the text is sent', async () => {
    // rezeis answers 200 for the upload and the connection drops half way
    // through the file: undici rejects the body read with `TypeError:
    // terminated`. That used to escape the banner resolver into the send's
    // error handling, and the notification itself was never sent.
    let downloads = 0;
    const rezeis = http.createServer((_req, res) => {
      downloads += 1;
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '100000' });
      res.write(Buffer.alloc(512, 0xff), () => res.socket?.destroy());
    });
    await new Promise<void>((resolve) => rezeis.listen(0, '127.0.0.1', resolve));
    const { port } = rezeis.address() as AddressInfo;
    const warn = vi.fn();
    const logger = { info: () => {}, warn, error: () => {}, debug: () => {} } as unknown as ListenerOptions['logger'];
    const harness = startHarness({ logger, rezeisAdminUrl: `http://127.0.0.1:${port}` });
    try {
      const answer = await harness.call('/notify', notification('banner-terminated', '/uploads/bot-banners/summer.jpg'));

      // Anchor: the download really started, and really died the way it does in production.
      expect(downloads).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.objectContaining({ message: 'terminated' }) }),
        expect.stringContaining('banner-resolver'),
      );
      expect(harness.sendPhoto).not.toHaveBeenCalled();
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.sendMessage.mock.calls[0]?.[1]).toBe('Подписка истекает завтра');
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ messageId: 101 });
    } finally {
      await harness.close();
      rezeis.closeAllConnections();
      await new Promise<void>((resolve) => rezeis.close(() => resolve()));
    }
  });
});

describe('bot notify routes — a permanent Telegram refusal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(ROUTES)('$path: answers 422 with Telegram’s reason, never a 2xx', async (route) => {
    const harness = startHarness({ devId: DEV_ID });
    const send = harness[route.send];
    const errorCode = route.refusal.startsWith('Forbidden') ? 403 : 400;
    send.mockRejectedValueOnce(telegramError(errorCode, route.refusal));
    try {
      const answer = await harness.call(route.path, route.body(freshEventId(`refusal${route.path}`)));

      expect(send).toHaveBeenCalledTimes(1);
      // A 2xx here is `unconfirmed` upstream, which the panel counts as a
      // DELIVERED operator card. 422 is `rejected`: terminal, undelivered, and
      // alerted everywhere but a dev route, where it is a quiet dead end.
      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.text)).toMatchObject({ error: route.refusal });
    } finally {
      await harness.close();
    }
  });

  it.each(ROUTES)('$path: a refused send keeps no claim, so a later delivery of that id is attempted', async (route) => {
    // The operator adds the bot to the chat and presses retry. The claim exists
    // to stop a second copy of a message; a refused send produced none.
    const harness = startHarness({ devId: DEV_ID });
    const send = harness[route.send];
    const eventId = freshEventId(`refusal-then-fixed${route.path}`);
    send.mockRejectedValueOnce(telegramError(route.refusal.startsWith('Forbidden') ? 403 : 400, route.refusal));
    try {
      expect((await harness.call(route.path, route.body(eventId))).status).toBe(422);
      const later = await harness.call(route.path, route.body(eventId));
      expect(send).toHaveBeenCalledTimes(2);
      expect(later.status).toBe(route.delivered);
    } finally {
      await harness.close();
    }
  });
});

describe('bot notify routes — a replay while the first send is still out', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(ROUTES)('$path: is told to come back, not that the message was delivered', async (route) => {
    const harness = startHarness({ devId: DEV_ID });
    const send = harness[route.send];
    const telegram: { answer?: (value: SendResult) => void } = {};
    send.mockImplementationOnce(
      () =>
        new Promise<SendResult>((resolve) => {
          telegram.answer = resolve;
        }),
    );
    const eventId = freshEventId(`in-flight${route.path}`);
    const first = harness.call(route.path, route.body(eventId));
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

      // The cabinet gave up on the first hop (8s) and the panel retried while
      // Telegram was still answering it. Nobody knows the outcome yet; a 2xx
      // would record a card that may never arrive as posted.
      const replay = await harness.call(route.path, route.body(eventId));
      expect(replay.status).toBe(503);
      expect(replay.retryAfter).toMatch(/^[1-9]\d*$/);
      expect(send).toHaveBeenCalledTimes(1);

      telegram.answer?.({ message_id: 303 });
      expect((await first).status).toBe(route.delivered);

      // Once it HAS arrived, a replay is a replay: no second copy, same answer.
      const late = await harness.call(route.path, route.body(eventId));
      expect(send).toHaveBeenCalledTimes(1);
      expect(late.status).toBe(route.delivered);
      if (route.delivered === 200) expect(JSON.parse(late.text)).toEqual({ messageId: 303 });
    } finally {
      // Never close the listener under a request still parked on the stub: a
      // failed assertion above would otherwise surface as a stray socket error.
      telegram.answer?.({ message_id: 303 });
      await first.catch(() => undefined);
      await harness.close();
    }
  });
});

describe('bot /notify — the per-recipient outcomes stay terminal and quiet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const body = (eventId: string) => ({ eventId, telegramId: '123456789', text: 'Подписка истекает завтра' });

  it('a subscriber who blocked the bot is still 204, and still reported', async () => {
    // The panel's contract for this one: `unconfirmed` on `reiwa.user.notify` is
    // undelivered, never retried, never alerted; the bot flips isBotBlocked.
    const harness = startHarness();
    harness.sendMessage.mockRejectedValueOnce(telegramError(403, 'Forbidden: bot was blocked by the user'));
    try {
      const answer = await harness.call('/notify', body(freshEventId('blocked')));
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(answer.status).toBe(204);
      expect(harness.onUserBlocked).toHaveBeenCalledWith('123456789');
    } finally {
      await harness.close();
    }
  });

  it('a blocked subscriber is answered only once the panel has recorded the block, when that takes 120 ms', async () => {
    // Broadcast delivery reads `isBotBlocked` back 50 ms after this answer
    // arrives, and that read is what files the row as "blocked by the user"
    // rather than as an error the operator is offered to retry. Answered first,
    // a panel that took longer than those 50 ms to record the block lost the race.
    const harness = startHarness();
    let blockRecordedAt: number | null = null;
    harness.onUserBlocked.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      blockRecordedAt = performance.now();
    });
    harness.sendMessage.mockRejectedValueOnce(telegramError(403, 'Forbidden: bot was blocked by the user'));
    try {
      const answer = await harness.call('/notify', body(freshEventId('blocked-120ms')));
      const answeredAt = performance.now();

      expect(answer.status).toBe(204);
      expect(harness.onUserBlocked).toHaveBeenCalledWith('123456789');
      expect(blockRecordedAt, 'the answer arrived before the block was recorded').not.toBeNull();
      expect(blockRecordedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(answeredAt);
    } finally {
      await harness.close();
    }
  });

  it('a panel that hangs is waited for about two seconds, then left to finish in the background', async () => {
    // The cap: `onUserBlocked` goes to the panel, whose transport waits up to
    // 10s for headers, and reiwa-api gives this whole hop 8s. Unbounded, a
    // slow panel turned this final, quiet 204 into the API's 502 — retried
    // (another send to the subscriber who blocked the bot), alerted, and counted
    // toward broadcast delivery's relay circuit breaker.
    const warn = vi.fn();
    const logger = { info: () => {}, warn, error: () => {}, debug: () => {} } as unknown as ListenerOptions['logger'];
    const harness = startHarness({ logger });
    const marking: { fail?: (err: Error) => void } = {};
    harness.onUserBlocked.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          marking.fail = reject;
        }),
    );
    harness.sendMessage.mockRejectedValueOnce(telegramError(403, 'Forbidden: bot was blocked by the user'));
    const startedAt = performance.now();
    const answer = harness.call('/notify', body(freshEventId('blocked-hanging-panel')));
    try {
      const outcome = await Promise.race([
        answer,
        new Promise<'still waiting on onUserBlocked'>((resolve) =>
          setTimeout(() => resolve('still waiting on onUserBlocked'), 4_000),
        ),
      ]);
      const elapsed = performance.now() - startedAt;

      expect(outcome).toMatchObject({ status: 204 });
      // It did wait: the panel got its chance to record the block first…
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      // …and not much past the cap, well inside reiwa-api's 8s for the hop.
      expect(elapsed).toBeLessThan(3_500);

      // The call is still running. When it fails, that is logged, not lost.
      marking.fail?.(new Error('panel timed out'));
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ telegramId: '123456789' }),
          'Notify: onUserBlocked callback threw',
        ),
      );
    } finally {
      marking.fail?.(new Error('panel timed out'));
      await answer.catch(() => undefined);
      await harness.close();
    }
  }, 10_000);

  it('a failing onUserBlocked is logged, and the subscriber is still answered 204', async () => {
    const warn = vi.fn();
    const logger = { info: () => {}, warn, error: () => {}, debug: () => {} } as unknown as ListenerOptions['logger'];
    const harness = startHarness({ logger });
    harness.onUserBlocked.mockRejectedValueOnce(new Error('panel unavailable'));
    harness.sendMessage.mockRejectedValueOnce(telegramError(403, 'Forbidden: bot was blocked by the user'));
    try {
      const answer = await harness.call('/notify', body(freshEventId('blocked-panel-down')));
      expect(answer.status).toBe(204);
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ telegramId: '123456789' }),
          'Notify: onUserBlocked callback threw',
        ),
      );
    } finally {
      await harness.close();
    }
  });

  it('a subscriber the bot cannot reach at all is the same quiet 204, without a block flag', async () => {
    // "chat not found" on a private chat: the person never started this bot
    // (typical for imported users). One operator alert per notification per
    // such subscriber is the flood `shouldAlertOperator` exists to prevent, and
    // it is not a block, so `isBotBlocked` is left alone.
    const harness = startHarness();
    harness.sendMessage.mockRejectedValueOnce(telegramError(400, 'Bad Request: chat not found'));
    try {
      const answer = await harness.call('/notify', body(freshEventId('unreachable')));
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(answer.status).toBe(204);
      expect(harness.onUserBlocked).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

describe('bot /notify-dev and /notify-dev-document — no dev recipient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DEV_ROUTES = ROUTES.filter((route) => route.path.startsWith('/notify-dev'));

  it.each(DEV_ROUTES)('$path: without BOT_DEV_ID answers 424, not a 204 nobody can tell from delivery', async (route) => {
    const harness = startHarness({});
    try {
      const answer = await harness.call(route.path, route.body(freshEventId(`no-dev${route.path}`)));
      expect(harness[route.send]).not.toHaveBeenCalled();
      expect(answer.status).toBe(424);
      expect(JSON.parse(answer.text)).toMatchObject({ error: expect.stringContaining('BOT_DEV_ID') });
    } finally {
      await harness.close();
    }
  });

  it.each(DEV_ROUTES)('$path: without a bot answers 503 like its siblings, not 204', async (route) => {
    const harness = startHarness({ devId: DEV_ID, withBot: false });
    try {
      const answer = await harness.call(route.path, route.body(freshEventId(`no-bot${route.path}`)));
      expect(answer.status).toBe(503);
    } finally {
      await harness.close();
    }
  });
});
