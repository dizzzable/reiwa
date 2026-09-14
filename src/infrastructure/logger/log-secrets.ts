/**
 * Secrets that reach a log line as TEXT, where `redact.paths` cannot see them.
 *
 * `redact.paths` removes a field by its NAME (`*.token`). A Bot API token also
 * travels inside text. grammY builds every request URL as
 * `<apiRoot>/bot<token>/<method>`, and on Node the transport error it wraps —
 * node-fetch 2.7's `FetchError`, under `HttpError.error` — quotes that URL in
 * its message and stack: `request to https://api.telegram.org/bot<TOKEN>/
 * sendMessage failed, reason: …`, `invalid json response body at
 * https://api.telegram.org/bot<TOKEN>/…`. pino's error serializer walks into
 * `HttpError.error` and folds every `cause` into the message and stack, so ANY
 * `logger.warn({ err }, …)` on a failed Bot API call wrote the token in the
 * clear — and a file URL (`/file/bot<TOKEN>/…`) logged under any name did too.
 *
 * `createLogger` installs both halves below, so no call site can forget:
 *
 *  - `redactBotTokens` as pino's `streamWrite` hook — the finished line, whatever
 *    key or message the token sits in, including the child loggers pino-http
 *    derives with an `err` serializer of its own;
 *  - `serializeErrorForLog` as the `err` serializer — pino's own, then without
 *    the request grammY attaches to a failed call (`payload`: a subscriber's
 *    message text, or an `InputFile` whose Buffer serializes byte by byte), and
 *    redacted too, so the serialized error is safe on its own.
 *
 * The error's type, code, Telegram's `error_code` and `description` and the
 * method stay readable — they are what a log line about a failure is for.
 */
import pino from 'pino';

/**
 * `bot<id>:<secret>` as a request URL carries it, the colon possibly
 * percent-encoded. Not preceded by a word character, so `robot1:` in prose is
 * left alone while `/bot1:…` and `"bot1:…` are not.
 */
const BOT_TOKEN_IN_TEXT_RE = /(?<![A-Za-z0-9_])bot\d+(?::|%3[Aa])[A-Za-z0-9_-]+/g;

export const REDACTED_BOT_TOKEN = 'bot<redacted>';

/** `text` with every Bot API token in it replaced by `bot<redacted>`. */
export function redactBotTokens(text: string): string {
  // Cheap exit for the lines that cannot hold one; the bot's own lines all say
  // `"service":"bot"`, so the expression still runs on most of them.
  return text.includes('bot') ? text.replace(BOT_TOKEN_IN_TEXT_RE, REDACTED_BOT_TOKEN) : text;
}

/** How many values one serialized error may visit; a bound, not a format. */
const MAX_NODES = 500;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;

/**
 * pino's `err` serializer, then scrubbed: token text redacted at every depth,
 * the request of a failed Bot API call dropped.
 *
 * `payload` is dropped only beside a string `method` — the shape of grammY's
 * `GrammyError` — so another library's error keeps a field of that name.
 */
export function serializeErrorForLog(err: unknown): unknown {
  const serialized: unknown = pino.stdSerializers.err(err as Error);
  const state = { nodes: 0, seen: new WeakSet<object>() };
  return scrub(serialized, 0, state);
}

function scrub(value: unknown, depth: number, state: { nodes: number; seen: WeakSet<object> }): unknown {
  if (typeof value === 'string') return redactBotTokens(value);
  if (typeof value !== 'object' || value === null) return value;
  if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
  if (state.seen.has(value)) return '[Circular]';
  state.nodes += 1;
  if (depth >= MAX_DEPTH || state.nodes > MAX_NODES) return '[…]';
  state.seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry: unknown) => scrub(entry, depth + 1, state));
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    try {
      return scrub((toJSON as () => unknown).call(value), depth + 1, state);
    } catch {
      return '[unserializable]';
    }
  }
  const source = value as Record<string, unknown>;
  const isBotApiCall = typeof source['method'] === 'string';
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (isBotApiCall && key === 'payload') continue;
    copy[key] = scrub(entry, depth + 1, state);
  }
  return copy;
}
