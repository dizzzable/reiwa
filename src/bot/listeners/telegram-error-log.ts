/**
 * A failed Bot API call, reduced to what a log line may carry.
 *
 * grammY's errors are not safe to hand to the logger as they come:
 *
 *  - an `HttpError` wraps what `fetch` threw, and node-fetch writes the request
 *    URL into that message and its stack — `request to https://api.telegram.org/
 *    bot<TOKEN>/sendMessage failed, reason: …`. pino's error serializer walks
 *    into the wrapped `error` and any `cause`, so `logger.error({ err })` on
 *    the outer error is enough to print the bot token in the clear;
 *  - a `GrammyError` carries the whole request `payload`: a subscriber's
 *    message text, or an `InputFile` whose Buffer serializes byte by byte.
 *
 * So a log line gets a copy built from an allow-list — name, message, stack, the
 * codes that say what failed, Telegram's own answer — for the error and each
 * error it wraps, with any `bot<id>:<secret>` in that text replaced. Anything not
 * on the list (a payload, a Buffer, a socket) never reaches the logger.
 */

/** A Bot API token as it appears in a request URL. */
const BOT_TOKEN_IN_TEXT_RE = /bot\d+:[A-Za-z0-9_-]+/g;

export function redactBotToken(text: string): string {
  return text.replace(BOT_TOKEN_IN_TEXT_RE, 'bot<redacted>');
}

/** Deep enough for grammY's `HttpError` -> node-fetch -> a cause; bounded against cycles. */
const MAX_WRAPPED_ERRORS = 4;
const MAX_AGGREGATED_ERRORS = 5;

/** Text that says what failed. `type` is left out: pino writes its own there. */
const TEXT_FIELDS = ['name', 'message', 'stack', 'code', 'syscall', 'method', 'description'] as const;
const NUMBER_FIELDS = ['errno', 'error_code'] as const;

/**
 * The loggable copy of `err`, for the `err` key of a log line. Built on a null
 * prototype so pino's serializer reports the original `name` as the type
 * rather than `Object`.
 */
export function loggableTelegramError(err: unknown): unknown {
  return reduce(err, 0);
}

function reduce(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactBotToken(value);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    const text = source[field];
    if (typeof text === 'string') copy[field] = redactBotToken(text);
  }
  if (typeof source['code'] === 'number') copy['code'] = source['code'];
  for (const field of NUMBER_FIELDS) {
    const number = source[field];
    if (typeof number === 'number' || typeof number === 'string') copy[field] = number;
  }
  const parameters = source['parameters'];
  if (typeof parameters === 'object' && parameters !== null) {
    const { retry_after: retryAfter, migrate_to_chat_id: migrateTo } = parameters as Record<string, unknown>;
    copy['parameters'] = {
      ...(typeof retryAfter === 'number' ? { retry_after: retryAfter } : {}),
      ...(typeof migrateTo === 'number' ? { migrate_to_chat_id: migrateTo } : {}),
    };
  }
  if (depth < MAX_WRAPPED_ERRORS) {
    // `error`: grammY's `HttpError`. `cause`: Node and undici.
    for (const field of ['error', 'cause'] as const) {
      if (source[field] !== undefined) copy[field] = reduce(source[field], depth + 1);
    }
    const aggregated = source['errors'];
    if (Array.isArray(aggregated)) {
      copy['errors'] = aggregated.slice(0, MAX_AGGREGATED_ERRORS).map((entry: unknown) => reduce(entry, depth + 1));
    }
  }
  return copy;
}
