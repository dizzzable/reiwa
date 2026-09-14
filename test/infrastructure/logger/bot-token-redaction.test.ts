/**
 * The Bot API token never reaches a log line, whichever call site logs a failed
 * Bot API call.
 *
 * grammY's transport error on Node is an `HttpError` wrapping node-fetch's
 * `FetchError`, and that one quotes the request URL — `…/bot<TOKEN>/sendMessage`
 * — in its message and stack. pino's default `err` serializer walks into the
 * wrapped error and folds causes into the message, so every
 * `logger.warn({ err }, …)` in the bot wrote the token in the clear;
 * `redact.paths` match field names and never see text. `createLogger` now
 * redacts centrally (`log-secrets.ts`), and this spec holds it to that for the
 * shapes a call site actually produces.
 *
 * The errors are real — made by grammY's own client against local sockets
 * (`grammy-failures.ts`) — and the logger is the real `createLogger` writing to
 * memory, so what is asserted is the line a log pipeline would receive.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';

import { Api, GrammyError, InputFile } from 'grammy';
import pino from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';

import { createErrorReporter } from '../../../src/infrastructure/error-reporter/index.js';
import { createLogger, redactBotTokens } from '../../../src/infrastructure/logger/index.js';
import { serializeErrorForLog } from '../../../src/infrastructure/logger/log-secrets.js';
import type { AdminClient } from '../../../src/lib/admin-client.js';
import { FAKE_BOT_TOKEN, captureGrammyFailures, type GrammyFailures } from '../../bot/grammy-failures.js';

/** The secret half: redacting only `bot<id>` would still leak it. */
const TOKEN_SECRET = FAKE_BOT_TOKEN.slice(FAKE_BOT_TOKEN.indexOf(':') + 1);
const MESSAGE_TEXT = 'LOGGER-SPEC-SUBSCRIBER-TEXT: подписка истекает завтра';
const REPORT_CAPTION = 'LOGGER-SPEC-REPORT-CAPTION';

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

/** The real `createLogger`, writing every line to memory. */
function capture(service: 'api' | 'bot' | 'worker' = 'bot') {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ service, level: 'trace', destination });
  return { logger, output: (): string => chunks.join('') };
}

function expectNoToken(text: string): void {
  expect(text, 'the bot token reached the log').not.toContain(FAKE_BOT_TOKEN);
  expect(text, 'the secret half of the token reached the log').not.toContain(TOKEN_SECRET);
}

describe('a failed Bot API call logged under err', () => {
  it.each([
    ['refused', '"code":"ECONNREFUSED"'],
    ['resetAfterRequest', '"code":"ECONNRESET"'],
    ['htmlBadGateway', 'invalid json response body'],
  ] as const)('never writes the token for a %s failure, and keeps %s readable', (name, readable) => {
    const failure = failures[name];
    // Anchor: the error really does carry the token, in text pino walks into.
    expect(inspect(failure)).toContain(FAKE_BOT_TOKEN);
    const { logger, output } = capture();

    logger.warn({ err: failure, lang: 'ru' }, 'setMyCommands (per-locale scope) failed');

    expectNoToken(output());
    expect(output()).toContain(readable);
    expect(output()).toContain('"type":"HttpError"');
    expect(output(), 'the URL stays recognisable, only the token goes').toContain('/bot<redacted>/sendMessage');
  });

  it('never writes it for an error passed as the first argument', () => {
    const { logger, output } = capture();

    logger.error(failures.refused);

    expectNoToken(output());
    expect(output()).toContain('ECONNREFUSED');
  });

  it('never writes it when the transport error arrives as a cause, which pino folds into the message', () => {
    const { logger, output } = capture();

    logger.error({ err: new Error('startup notice failed', { cause: failures.resetAfterRequest.error }) }, 'notice');

    expectNoToken(output());
    expect(output()).toContain('startup notice failed');
  });

  it('serializes the error safely on its own, before the line is written', () => {
    const serialized = JSON.stringify(serializeErrorForLog(failures.refused));

    expectNoToken(serialized);
    expect(serialized).toContain('ECONNREFUSED');
  });
});

describe('a token quoted anywhere else on the line', () => {
  it('is redacted in the message and under any key', () => {
    const { logger, output } = capture();
    const reason = (failures.refused.error as Error).message;

    logger.warn(
      { url: `https://api.telegram.org/file/bot${FAKE_BOT_TOKEN}/photos/file_1.jpg` },
      `banner download failed: ${reason}`,
    );

    expectNoToken(output());
    expect(output()).toContain('/file/bot<redacted>/photos/file_1.jpg');
  });

  it('is redacted with its colon percent-encoded', () => {
    const { logger, output } = capture();
    const encoded = FAKE_BOT_TOKEN.replace(':', '%3A');

    logger.info({ proxied: `GET /bot${encoded}/getMe 502` }, 'proxy said');

    expect(output()).not.toContain(TOKEN_SECRET);
  });

  it('is redacted by a child logger that brings an err serializer of its own, as pino-http does', () => {
    const { logger, output } = capture('api');
    const child = logger.child({}, { serializers: { err: pino.stdSerializers.err } });

    child.error({ err: failures.htmlBadGateway }, 'request failed');

    expectNoToken(output());
  });
});

describe('the request a failed call carried', () => {
  it('leaves out the subscriber text of a sendMessage, keeping what Telegram answered', () => {
    // Anchor: the payload holds the text.
    expect(JSON.stringify(failures.serverError.payload)).toContain(MESSAGE_TEXT);
    const { logger, output } = capture();

    logger.warn({ err: failures.serverError, telegramId: 42 }, 'Notify send failed');

    expect(output(), 'the subscriber’s message text reached the log').not.toContain(MESSAGE_TEXT);
    expect(output()).toContain('"error_code":500');
    expect(output()).toContain('"description":"Internal Server Error"');
    expect(output()).toContain('"method":"sendMessage"');
  });

  it('leaves out a document upload: its caption and its bytes', () => {
    expect(JSON.stringify(documentServerError.payload)).toContain(REPORT_CAPTION);
    const { logger, output } = capture();

    logger.error({ err: documentServerError }, 'Error report upload failed');

    expect(output()).not.toContain(REPORT_CAPTION);
    expect(output(), 'the InputFile Buffer was serialized byte by byte').not.toContain('"type":"Buffer"');
    expect(output()).toContain('"method":"sendDocument"');
  });

  it('keeps a field named payload on an error that is not a Bot API call', () => {
    const { logger, output } = capture();

    logger.warn({ err: Object.assign(new Error('validation failed'), { payload: { field: 'email' } }) }, 'invalid');

    expect(output()).toContain('"field":"email"');
  });
});

describe('what the redaction must not touch', () => {
  it('leaves ordinary lines as they were, and field redaction still removes a token field', () => {
    const { logger, output } = capture();

    logger.info({ telegramId: 123456789, note: 'robot1:ok', config: { token: 'field-secret' } }, 'bot started as @reiwa_bot');

    expect(output()).toContain('"note":"robot1:ok"');
    expect(output()).toContain('"telegramId":123456789');
    expect(output()).toContain('bot started as @reiwa_bot');
    expect(output()).not.toContain('field-secret');
  });

  it('terminates on an error that references itself', () => {
    const { logger, output } = capture();
    const err = new Error('cyclic');
    Object.assign(err, { details: { back: err, url: `https://api.telegram.org/bot${FAKE_BOT_TOKEN}/getMe` } });

    logger.error({ err }, 'cyclic');

    expectNoToken(output());
    expect(output()).toContain('cyclic');
    // Visited once, not unrolled to the depth bound: a wide error graph would
    // otherwise be copied again at every level it is reachable from.
    expect(output()).toContain('[Circular]');
  });
});

describe('the other ways an error text leaves the process', () => {
  it('reports to rezeis without the token, which rezeis would put on an operator card', () => {
    const reported: Array<{ message: string; stack?: string }> = [];
    const adminClient = {
      system: {
        reportError: async (input: { message: string; stack?: string }) => {
          reported.push(input);
        },
      },
    } as unknown as AdminClient;
    const fetchError = failures.refused.error as Error;

    createErrorReporter({ adminClient, source: 'bot' }).report({
      message: `Unhandled promise rejection: ${fetchError.message}`,
      stack: fetchError.stack,
    });

    expect(reported).toHaveLength(1);
    expectNoToken(JSON.stringify(reported[0]));
    expect(reported[0]?.message).toContain('bot<redacted>');
  });

  it('prints a startup failure as redacted text (src/bot/main.ts)', () => {
    expect(inspect(failures.refused)).toContain(FAKE_BOT_TOKEN);

    expectNoToken(redactBotTokens(inspect(failures.refused)));
  });
});
