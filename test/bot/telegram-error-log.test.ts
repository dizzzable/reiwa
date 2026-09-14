/**
 * `loggableTelegramError` — the copy of a failed Bot API call a log line gets.
 *
 * The listener spec (`internal-listener-error-logs.test.ts`) drives it through
 * real grammY errors, which nest one level (`HttpError.error`). These pin the
 * shapes grammY does not produce but Node and undici do — a `cause` chain, an
 * `AggregateError` — and that the copy still reads as the error it came from
 * once pino has serialized it.
 */
import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { loggableTelegramError, redactBotToken } from '../../src/bot/listeners/telegram-error-log.js';

const TOKEN = '987654321:AAEdifferentFakeTokenForTheUnitSpec_xyz';
const URL_WITH_TOKEN = `https://api.telegram.org/bot${TOKEN}/sendDocument`;

function logged(entry: Record<string, unknown>): string {
  const lines: string[] = [];
  const logger = pino(
    { level: 'trace' },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    }),
  );
  logger.error(entry, 'spec');
  return lines.join('');
}

describe('redactBotToken', () => {
  it('replaces every token in a text, secret half included', () => {
    const text = `request to ${URL_WITH_TOKEN} failed; retried ${URL_WITH_TOKEN}`;
    const redacted = redactBotToken(text);
    expect(redacted).toBe(
      'request to https://api.telegram.org/bot<redacted>/sendDocument failed; retried https://api.telegram.org/bot<redacted>/sendDocument',
    );
  });
});

describe('loggableTelegramError', () => {
  it('redacts through a cause chain, and pino prints no token from any link', () => {
    // undici's shape: `TypeError: fetch failed` whose cause is the system error.
    const inner = Object.assign(new Error(`connect ECONNREFUSED for ${URL_WITH_TOKEN}`), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
    });
    const outer = new TypeError('fetch failed', { cause: inner });

    const copy = loggableTelegramError(outer) as { readonly cause: Record<string, unknown> };
    const text = logged({ err: copy });

    // Anchor: the raw error WOULD print it — the serializer folds causes in.
    expect(logged({ err: outer })).toContain(TOKEN);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('ECONNREFUSED');
    // The cause keeps what says where it failed. (pino prints a cause only as
    // message and stack text, so this is read off the copy.)
    expect(copy.cause).toMatchObject({ code: 'ECONNREFUSED', syscall: 'connect' });
  });

  it('redacts each error an AggregateError holds', () => {
    const aggregate = new AggregateError(
      [new Error(`connect ETIMEDOUT ${URL_WITH_TOKEN}`), new Error(`connect ENETUNREACH ${URL_WITH_TOKEN}`)],
      '',
    );
    const text = logged({ err: loggableTelegramError(aggregate) });
    expect(logged({ err: aggregate })).toContain(TOKEN);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('ENETUNREACH');
  });

  it('keeps the original name as the logged type, and nothing off the allow-list', () => {
    const grammyLike = Object.assign(new Error("Call to 'sendDocument' failed! (500: Internal Server Error)"), {
      name: 'GrammyError',
      method: 'sendDocument',
      error_code: 500,
      description: 'Internal Server Error',
      parameters: { retry_after: 3, unexpected: 'kept out' },
      payload: { chat_id: -100, caption: 'a subscriber-facing caption', document: { fileData: Buffer.from('bytes') } },
    });
    const text = logged({ err: loggableTelegramError(grammyLike) });
    expect(text).toContain('"type":"GrammyError"');
    expect(text).toContain('"error_code":500');
    expect(text).toContain('"retry_after":3');
    expect(text).not.toContain('payload');
    expect(text).not.toContain('a subscriber-facing caption');
    expect(text).not.toContain('kept out');
  });

  it('survives a cycle and a non-error value', () => {
    const looped: Error & { cause?: unknown } = new Error(`looped ${URL_WITH_TOKEN}`);
    looped.cause = looped;
    expect(() => logged({ err: loggableTelegramError(looped) })).not.toThrow();
    expect(logged({ err: loggableTelegramError(looped) })).not.toContain(TOKEN);
    expect(loggableTelegramError(`thrown string ${URL_WITH_TOKEN}`)).toBe(
      'thrown string https://api.telegram.org/bot<redacted>/sendDocument',
    );
    expect(loggableTelegramError(undefined)).toBeUndefined();
  });
});
