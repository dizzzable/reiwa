/**
 * What the bot's internal listener writes to its log when a Bot API call fails.
 *
 * grammY's errors are not safe to log as they come:
 *
 *  - an `HttpError` wraps what `fetch` threw, and node-fetch puts the request
 *    URL in that message — `request to https://api.telegram.org/bot<TOKEN>/
 *    sendMessage failed, reason: …`. pino's error serializer walks into the
 *    wrapped `error` (and any `cause`) and prints its message and stack, so a
 *    plain `logger.error({ err })` wrote the bot token into the log on every
 *    failed send;
 *  - a `GrammyError` carries the request `payload`: a subscriber's message
 *    text, or an `InputFile` whose Buffer serializes byte by byte.
 *
 * The errors here are real — made by grammY's own client (`grammy-failures.ts`)
 * with a token in the URL — and the logger is a real pino instance writing to
 * memory, so what is asserted is the log line as it would be shipped, not the
 * object handed to the logger.
 */
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { Api, GrammyError, InputFile } from 'grammy';
import pino from 'pino';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { BotConfig } from '../../src/infrastructure/bot-config/types.js';
import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';
import { FAKE_BOT_TOKEN, captureGrammyFailures, type GrammyFailures } from './grammy-failures.js';

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const SECRET = 's'.repeat(32);
/** The secret half of the token: redacting only `bot<id>` would still leak it. */
const TOKEN_SECRET = FAKE_BOT_TOKEN.slice(FAKE_BOT_TOKEN.indexOf(':') + 1);
const MESSAGE_TEXT = 'LOG-SPEC-SUBSCRIBER-TEXT: подписка истекает завтра';
const REPORT_CAPTION = 'LOG-SPEC-REPORT-CAPTION';

let failures: GrammyFailures;
/** A JSON 500 answered to a real document upload: its payload holds an InputFile. */
let documentServerError: GrammyError;

beforeAll(async () => {
  failures = await captureGrammyFailures(MESSAGE_TEXT);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await new Api(FAKE_BOT_TOKEN, { apiRoot: `http://127.0.0.1:${port}` })
      .sendDocument(-1001234567890, new InputFile(Buffer.from('full error report, byte for byte'), 'error.txt'), {
        caption: REPORT_CAPTION,
      })
      .then(
        () => {
          throw new Error('the document upload was expected to fail');
        },
        (err: unknown) => {
          if (!(err instanceof GrammyError)) throw err;
          documentServerError = err;
        },
      );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

/** A pino logger like the bot's (`createLogger`), writing its lines to memory. */
function memoryLogger(): { readonly logger: ListenerOptions['logger']; readonly text: () => string } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: pino({ level: 'trace' }, sink), text: () => lines.join('') };
}

let idCounter = 0;
function freshEventId(label: string): string {
  idCounter += 1;
  return `error-logs:${label}:${process.pid}:${Date.now()}:${idCounter}`;
}

async function startListener(opts: Partial<ListenerOptions> & { readonly logger: ListenerOptions['logger'] }) {
  const server = startInternalHttpListener({
    bot: null,
    cache: null,
    secret: SECRET,
    port: 0,
    ...opts,
  });
  if (server === null) throw new Error('listener did not start');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const call = async (path: string, body: Record<string, unknown>): Promise<number> => {
    const raw = JSON.stringify(body);
    const { timestamp, signature } = buildInternalSignature({ secret: SECRET, method: 'POST', path, body: raw });
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { call, close };
}

function expectNoToken(logText: string): void {
  expect(logText).not.toContain(FAKE_BOT_TOKEN);
  expect(logText).not.toContain(TOKEN_SECRET);
}

describe('internal listener logs — a failed send never writes the bot token', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('anchor: the fixtures really carry the token where grammY puts it', () => {
    // Otherwise "the log holds no token" would be true of an error that never had one.
    expect((failures.refused.error as Error).message).toContain(`/bot${FAKE_BOT_TOKEN}/sendMessage`);
    expect((failures.resetAfterRequest.error as Error).message).toContain(`/bot${FAKE_BOT_TOKEN}/sendMessage`);
    expect(JSON.stringify(failures.serverError.payload)).toContain(MESSAGE_TEXT);
  });

  const SEND_FAILURES = [
    { label: 'a refused connection', error: () => failures.refused, code: 'ECONNREFUSED', carriesUrl: true },
    { label: 'a connection reset after the request', error: () => failures.resetAfterRequest, code: 'ECONNRESET', carriesUrl: true },
    { label: 'an HTML 502', error: () => failures.htmlBadGateway, code: 'invalid json response body', carriesUrl: true },
    // No URL in this one: it guards that the reduction keeps the diagnosis.
    { label: "grammY's timeout", error: () => failures.timedOut, code: 'timed out after 1 seconds', carriesUrl: false },
  ] as const;

  it.each(SEND_FAILURES)('/notify-broadcast: $label is logged without the token, and still says what failed', async ({ error, code, carriesUrl }) => {
    const log = memoryLogger();
    const sendMessage = vi.fn(async (): Promise<{ message_id: number }> => {
      throw error();
    });
    const listener = await startListener({
      logger: log.logger,
      bot: { api: { sendMessage } } as unknown as ListenerOptions['bot'],
    });
    try {
      const status = await listener.call('/notify-broadcast', {
        eventId: freshEventId('broadcast'),
        chatId: '-1001234567890',
        text: 'Новый платёж',
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(status).toBe(502);
      // Anchor: the failure line was written, so its absence of a token means something.
      expect(log.text()).toContain('Broadcast: ');
      expectNoToken(log.text());
      // Redacted, not dropped: the operator can still tell a refusal from a
      // reset, and see which endpoint was called.
      expect(log.text()).toContain(code);
      if (carriesUrl) expect(log.text()).toContain('/bot<redacted>/sendMessage');
    } finally {
      await listener.close();
    }
  });

  it('/notify-broadcast: a Telegram 5xx is logged without the message text it was carrying', async () => {
    const log = memoryLogger();
    const sendMessage = vi.fn(async (): Promise<{ message_id: number }> => {
      throw failures.serverError;
    });
    const listener = await startListener({
      logger: log.logger,
      bot: { api: { sendMessage } } as unknown as ListenerOptions['bot'],
    });
    try {
      const status = await listener.call('/notify-broadcast', {
        eventId: freshEventId('broadcast-5xx'),
        chatId: '-1001234567890',
        text: 'Новый платёж',
      });
      expect(status).toBe(502);
      expect(log.text()).toContain('Internal Server Error');
      expect(log.text()).not.toContain(MESSAGE_TEXT);
      expect(log.text()).not.toContain('"payload"');
    } finally {
      await listener.close();
    }
  });

  it('/notify-broadcast-document: a failed upload is logged without the file bytes or the caption', async () => {
    const log = memoryLogger();
    const sendDocument = vi.fn(async (): Promise<{ message_id: number }> => {
      throw documentServerError;
    });
    const listener = await startListener({
      logger: log.logger,
      bot: { api: { sendDocument } } as unknown as ListenerOptions['bot'],
    });
    try {
      const status = await listener.call('/notify-broadcast-document', {
        eventId: freshEventId('document-5xx'),
        chatId: '-1001234567890',
        content: 'full error report',
      });
      expect(status).toBe(502);
      expect(log.text()).toContain('Broadcast document: ');
      expect(log.text()).not.toContain(REPORT_CAPTION);
      expect(log.text()).not.toContain('fileData');
      expect(log.text()).not.toContain('"type":"Buffer"');
    } finally {
      await listener.close();
    }
  });

  it('/notify: a banner photo that failed is logged without the token before the text fallback', async () => {
    const log = memoryLogger();
    const sendPhoto = vi.fn(async (): Promise<{ message_id: number }> => {
      throw failures.refused;
    });
    const sendMessage = vi.fn(async () => ({ message_id: 77 }));
    const listener = await startListener({
      logger: log.logger,
      bot: { api: { sendPhoto, sendMessage } } as unknown as ListenerOptions['bot'],
    });
    try {
      const status = await listener.call('/notify', {
        eventId: freshEventId('photo'),
        telegramId: '123456789',
        text: 'Подписка истекает завтра',
        bannerUrl: 'https://cdn.example.com/banner.jpg',
      });
      expect(sendPhoto).toHaveBeenCalledTimes(1);
      expect(status).toBe(200);
      expect(log.text()).toContain('Notify: sendPhoto failed');
      expectNoToken(log.text());
    } finally {
      await listener.close();
    }
  });

  it('/notify-backup-document: a failed upload is logged without the token', async () => {
    const log = memoryLogger();
    // The rezeis download; the upload is what fails.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('backup-bytes', { status: 200 }));
    const sendDocument = vi.fn(async (): Promise<{ message_id: number }> => {
      throw failures.resetAfterRequest;
    });
    const listener = await startListener({
      logger: log.logger,
      bot: { api: { sendDocument } } as unknown as ListenerOptions['bot'],
      rezeisAdminUrl: 'http://rezeis:8000',
    });
    try {
      const status = await listener.call('/notify-backup-document', {
        recordId: 'ckbackup0001',
        token: 'signed-download-token',
        chatId: '-1001234567890',
      });
      expect(sendDocument).toHaveBeenCalledTimes(1);
      expect(status).toBe(204);
      expect(log.text()).toContain('Notify-backup-document: send failed');
      expectNoToken(log.text());
    } finally {
      await listener.close();
    }
  });

  it('/invalidate: a Bot API push that failed after the refresh is logged without the token', async () => {
    // `onConfigApplied` pushes the slash commands and the bot profile — Bot API
    // calls, failing with the same errors.
    const log = memoryLogger();
    const onConfigApplied = vi.fn(async (): Promise<void> => {
      throw failures.refused;
    });
    const cache = { forceInvalidate: vi.fn(async () => ({}) as BotConfig) };
    const listener = await startListener({
      logger: log.logger,
      cache: cache as unknown as ListenerOptions['cache'],
      onConfigApplied,
    });
    try {
      expect(await listener.call('/invalidate', { reason: 'test' })).toBe(204);
      await vi.waitFor(() => expect(log.text()).toContain('Cache-invalidate: post-refresh apply failed'));
      expectNoToken(log.text());
    } finally {
      await listener.close();
    }
  });
});
