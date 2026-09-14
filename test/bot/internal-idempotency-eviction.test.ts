/**
 * The bot's idempotency cache under pressure: what it may drop when it is full.
 *
 * `IDEMPOTENCY_CACHE` holds 1024 event ids. An entry is one of two things:
 *
 *  - IN FLIGHT — claimed, and its send has not settled. It is the only thing
 *    stopping a replay of that event (the panel retries after 15s; reiwa-api
 *    gives up on the hop after 8s) from sending a second copy while the first
 *    send is still out. Dropped, the replay sends again — and the first send's
 *    late settle or release then lands on the replay's claim instead of its own.
 *  - DELIVERED — Telegram took the message. Dropped, a later replay sends again:
 *    the cost of a bounded cache, the same as a bot restart.
 *
 * So a full cache makes room from the delivered entries, oldest first, and never
 * from an in-flight one. The cache is a module singleton, which vitest isolates
 * per spec file — hence a file of its own for flooding it.
 *
 * Real listener, real socket, real internal-HMAC headers; only `bot.api` is a
 * stub. Measured on the stub's call count per chat.
 */
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const SECRET = 's'.repeat(32);
/** `IdempotencyCache`'s capacity, as a literal: importing it would let the two agree by construction. */
const CACHE_SLOTS = 1024;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

interface Answer {
  readonly status: number;
  readonly text: string;
}

async function startListener(sendMessage: (...args: unknown[]) => Promise<{ message_id: number }>) {
  const server = startInternalHttpListener({
    bot: { api: { sendMessage } } as unknown as ListenerOptions['bot'],
    cache: null,
    secret: SECRET,
    port: 0,
    logger: silentLogger,
  });
  if (server === null) throw new Error('listener did not start');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  // Keep-alive: the flood below is a thousand requests.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

  const notify = async (eventId: string, chatId: string): Promise<Answer> => {
    const path = '/notify-broadcast';
    const raw = JSON.stringify({ eventId, chatId, text: 'Новый платёж' });
    const { timestamp, signature } = buildInternalSignature({ secret: SECRET, method: 'POST', path, body: raw });
    return await new Promise<Answer>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          agent,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
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
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('error', reject);
      req.end(raw);
    });
  };

  const close = async (): Promise<void> => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { notify, close };
}

/** Deliver `count` distinct events, a few at a time. */
async function flood(notify: (eventId: string, chatId: string) => Promise<Answer>, count: number): Promise<void> {
  const BATCH = 32;
  for (let start = 0; start < count; start += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, count - start) }, (_, i) =>
      notify(`eviction:flood:${start + i}`, '-1000000000001'),
    );
    for (const answer of await Promise.all(batch)) expect(answer.status).toBe(200);
  }
}

describe('bot idempotency cache — a full cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps an in-flight event while more than 1024 delivered ones arrive, and drops the oldest delivered instead', async () => {
    const sentTo = new Map<string, number>();
    const firstSend: { finish?: (value: { message_id: number }) => void } = {};
    let nextId = 5000;
    const sendMessage = vi.fn(async (chatId: unknown): Promise<{ message_id: number }> => {
      const chat = String(chatId);
      sentTo.set(chat, (sentTo.get(chat) ?? 0) + 1);
      // The in-flight channel post: Telegram has not answered yet.
      if (chat === '-1000000000999' && firstSend.finish === undefined) {
        return await new Promise((resolve) => {
          firstSend.finish = resolve;
        });
      }
      nextId += 1;
      return { message_id: nextId };
    });
    const listener = await startListener(sendMessage);
    // The oldest entry of all: claimed first, and still in flight.
    const inFlight = listener.notify('eviction:in-flight', '-1000000000999');
    try {
      await vi.waitFor(() => expect(firstSend.finish).toBeDefined());
      // The oldest DELIVERED entry: the first one a full cache may drop.
      expect((await listener.notify('eviction:oldest-delivered', '-1000000000002')).status).toBe(200);

      await flood(listener.notify, CACHE_SLOTS + 64);

      // Anchor: the cache really was full — its oldest delivered entry is gone,
      // so a replay of it is sent again.
      const replayOfEvicted = await listener.notify('eviction:oldest-delivered', '-1000000000002');
      expect(replayOfEvicted.status).toBe(200);
      expect(sentTo.get('-1000000000002')).toBe(2);

      // The in-flight entry is not: its replay is told to come back later, and
      // nothing is sent a second time while the first send is still out.
      const replayInFlight = await listener.notify('eviction:in-flight', '-1000000000999');
      expect(replayInFlight.status).toBe(503);
      expect(sentTo.get('-1000000000999')).toBe(1);

      // And when the first send lands, it settles its OWN claim: the replay gets
      // that post's address, still without a second send.
      firstSend.finish?.({ message_id: 777 });
      expect(await inFlight).toMatchObject({ status: 200 });
      const late = await listener.notify('eviction:in-flight', '-1000000000999');
      expect(JSON.parse(late.text)).toEqual({ messageId: 777 });
      expect(sentTo.get('-1000000000999')).toBe(1);
    } finally {
      firstSend.finish?.({ message_id: 777 });
      await inFlight.catch(() => undefined);
      await listener.close();
    }
  }, 60_000);
});
