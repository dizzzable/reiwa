/**
 * `/notify-dev` and `/notify-dev-document` — replay protection for the two
 * dev-fallback relays.
 *
 * These two carry the system-event card and the full `.txt` error report to the
 * bot's `BOT_DEV_ID` when no operator group/topic is configured. rezeis now
 * relays them off a BullMQ queue with 4 attempts and a 15s/30s/60s backoff
 * (`modules/notifications/reiwa-relay.policy.ts`), so the same card can reach
 * this listener up to four times — and until this fix they were the only two
 * retried events the bot could not dedup, which the panel records as
 * `botDedupKeyed: false`.
 *
 * `eventId` is OPTIONAL on this pair. A panel older than the one that started
 * stamping it sends none, and rejecting that payload would silence the dev
 * firehose during the outage it exists to report, so a keyless delivery must
 * still go through.
 *
 * Everything is measured on `bot.api.sendMessage` / `bot.api.sendDocument`
 * call counts — the real side effect, not the HTTP status: a suppressed replay
 * and a delivered card both answer 204, so the status alone cannot tell them
 * apart. The listener runs on a real socket with real internal-HMAC headers, so
 * routing and auth are covered too.
 */
import http from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';
import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';

const SECRET = 's'.repeat(32);
const DEV_ID = 555000111;

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

/**
 * The idempotency cache is a module-level singleton with a 24h horizon, so ids
 * leak between tests in this file (and would between files, on one worker).
 * Mint a fresh one per assertion instead of trying to reset it — a test that
 * reuses a literal would pass for the wrong reason the second time it ran.
 */
let idCounter = 0;
function freshEventId(label: string): string {
  idCounter += 1;
  return `sysevt:test:${label}:${process.pid}:${Date.now()}:${idCounter}`;
}

interface DevHarness {
  /** POST one relay at the live listener; resolves with its HTTP status. */
  readonly call: (path: string, body: Record<string, unknown>) => Promise<number>;
  /** Arguments of every `bot.api.sendMessage` call, in order. */
  readonly sendMessage: ReturnType<typeof vi.fn>;
  /** Arguments of every `bot.api.sendDocument` call, in order. */
  readonly sendDocument: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

/**
 * Boot the real listener on an ephemeral port with a stubbed grammY api.
 *
 * The stubs are `vi.fn()`s that RESOLVE — a stub that swallowed the call
 * without recording it would make "the replay was suppressed" and "the handler
 * never sent anything at all" the same observation, which is the whole thing
 * these tests are trying to tell apart. `devId` is supplied for the same
 * reason: without it both dev endpoints no-op at 204 and every count below
 * would read zero for a reason that has nothing to do with idempotency.
 */
function startDevHarness(): DevHarness {
  const sendMessage = vi.fn(async () => ({ message_id: 1 }));
  const sendDocument = vi.fn(async () => ({ message_id: 2 }));
  const bot = { api: { sendMessage, sendDocument } } as unknown as ListenerOptions['bot'];

  const server = startInternalHttpListener({
    bot,
    cache: null,
    secret: SECRET,
    port: 0,
    logger: silentLogger,
    devId: DEV_ID,
  });
  if (server === null) throw new Error('listener did not start');
  const ready = once(server, 'listening');

  const call = async (path: string, body: Record<string, unknown>): Promise<number> => {
    await ready;
    const { port } = server.address() as { port: number };
    const raw = JSON.stringify(body);
    const { timestamp, signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path,
      body: raw,
    });
    return await new Promise<number>((resolve, reject) => {
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
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
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

  return { call, sendMessage, sendDocument, close };
}

describe('bot /notify-dev — replay protection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends one card when the panel retries the same eventId', async () => {
    const harness = startDevHarness();
    const eventId = freshEventId('dev-repeat');
    try {
      const first = await harness.call('/notify-dev', { eventId, text: 'СБОЙ: очередь встала' });
      const second = await harness.call('/notify-dev', { eventId, text: 'СБОЙ: очередь встала' });

      // Anchor: the first attempt really delivered. Without this a handler that
      // sends nothing at all would satisfy the "exactly one" bound below.
      expect(harness.sendMessage.mock.calls[0]?.[1]).toBe('СБОЙ: очередь встала');
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      // Both answer 204 — a suppressed replay is a success for the caller, not
      // something to retry. Which is also why the status cannot be the measure.
      expect([first, second]).toEqual([204, 204]);
    } finally {
      await harness.close();
    }
  });

  it('sends both cards when the eventIds differ', async () => {
    const harness = startDevHarness();
    try {
      await harness.call('/notify-dev', { eventId: freshEventId('dev-a'), text: 'первый' });
      await harness.call('/notify-dev', { eventId: freshEventId('dev-b'), text: 'второй' });

      expect(harness.sendMessage).toHaveBeenCalledTimes(2);
      expect(harness.sendMessage.mock.calls.map((c) => c[1])).toEqual(['первый', 'второй']);
    } finally {
      await harness.close();
    }
  });

  it('still delivers when the panel sends no eventId at all', async () => {
    // The compatibility case: rezeis before the relay queue sends
    // `{ text, parseMode }` and nothing else. Two such calls are
    // indistinguishable, so both must go through — the alternative is a 400
    // that drops the alert, which is strictly worse than a duplicate.
    const harness = startDevHarness();
    try {
      const first = await harness.call('/notify-dev', { text: 'старая панель' });
      const second = await harness.call('/notify-dev', { text: 'старая панель' });

      expect([first, second]).toEqual([204, 204]);
      expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it('treats a blank eventId as no key rather than as one shared key', async () => {
    // `''` must not become a cache slot every keyless-ish payload collides on:
    // that would let one card silence every later one for 24h.
    const harness = startDevHarness();
    try {
      await harness.call('/notify-dev', { eventId: '   ', text: 'пустой ключ 1' });
      await harness.call('/notify-dev', { eventId: '', text: 'пустой ключ 2' });

      expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });
});

describe('bot /notify-dev-document — replay protection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads one report when the panel retries the same eventId', async () => {
    const harness = startDevHarness();
    const eventId = freshEventId('doc-repeat');
    const body = { eventId, content: 'full error report', filename: 'error_0.txt' };
    try {
      const first = await harness.call('/notify-dev-document', body);
      const second = await harness.call('/notify-dev-document', body);

      // Anchor: the first upload really happened, and reached the dev id.
      expect(harness.sendDocument.mock.calls[0]?.[0]).toBe(DEV_ID);
      expect(harness.sendDocument).toHaveBeenCalledTimes(1);
      expect([first, second]).toEqual([204, 204]);
    } finally {
      await harness.close();
    }
  });

  it('uploads both reports when the eventIds differ', async () => {
    const harness = startDevHarness();
    try {
      await harness.call('/notify-dev-document', {
        eventId: freshEventId('doc-a'),
        content: 'report a',
      });
      await harness.call('/notify-dev-document', {
        eventId: freshEventId('doc-b'),
        content: 'report b',
      });

      expect(harness.sendDocument).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it('still uploads when the panel sends no eventId at all', async () => {
    const harness = startDevHarness();
    try {
      const first = await harness.call('/notify-dev-document', { content: 'старая панель' });
      const second = await harness.call('/notify-dev-document', { content: 'старая панель' });

      expect([first, second]).toEqual([204, 204]);
      expect(harness.sendDocument).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it('does not let the card swallow the report that shares its eventId', async () => {
    // One system event produces both halves — the card and the attached `.txt`.
    // The dedup cache is a single keyspace shared by all five senders, so an
    // unscoped claim would make the second half look like a replay of the first
    // and the operator would get a card with no report behind it.
    const harness = startDevHarness();
    const eventId = freshEventId('shared');
    try {
      await harness.call('/notify-dev', { eventId, text: 'карточка' });
      await harness.call('/notify-dev-document', { eventId, content: 'отчёт' });

      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.sendDocument).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });
});
