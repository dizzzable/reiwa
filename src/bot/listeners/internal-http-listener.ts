/**
 * Internal HTTP listener — single Node-native server bound to
 * `BOT_INVALIDATE_PORT` (default 5100). Exposes a narrow set of
 * admin-pushed endpoints.
 *
 * Auth (either is accepted):
 *   - HMAC signature (preferred): `x-request-timestamp` + `x-request-signature`
 *     over `METHOD\nPATH\nTIMESTAMP\nsha256(body)` keyed with
 *     `REZEIS_INTERNAL_SHARED_SECRET` (see `lib/internal-hmac.ts`). The
 *     secret never travels on the wire and a stale timestamp is rejected —
 *     this is what makes the hop safe when admin and bot are on different
 *     VPS reaching each other over the public internet.
 *   - Legacy shared-secret header `X-Auth-Token` == `REZEIS_INTERNAL_SHARED_SECRET`
 *     (transitional: safe only on a private docker network or behind TLS;
 *     kept so same-host deployments keep working until admin signs).
 *
 * Endpoints:
 *
 *   POST /invalidate
 *     Force-refresh the in-process bot config cache. Rezeis-admin
 *     pushes this whenever an operator saves the BotConfig so the
 *     next user request sees fresh data without waiting up to 5 min
 *     for the periodic refresh.
 *
 *   POST /notify
 *     Deliver a per-user Telegram message. Body shape:
 *       {
 *         eventId: string,                       // CUID, idempotency key
 *         telegramId: string,                    // numeric, decimal
 *         text: string,                          // markdown OK
 *         parseMode?: 'MarkdownV2' | 'HTML',     // optional
 *         buttons?: Array<{                       // optional inline keyboard
 *           text: string,
 *           url?: string,
 *           callbackData?: string,
 *         }>,
 *       }
 *     Idempotency is enforced via an in-memory LRU of recent
 *     `eventId`s (24h horizon). Repeat deliveries no-op.
 *
 *   POST /notify-broadcast
 *     Deliver a Telegram message to a chat / topic. Body shape:
 *       {
 *         eventId: string,
 *         chatId: string,
 *         topicThreadId?: number,
 *         text: string,
 *         parseMode?: 'MarkdownV2' | 'HTML',
 *         buttons?: Array<{ text, url?, callbackData? }>,
 *       }
 *
 * Bound to `0.0.0.0`. When split across VPS, expose it ONLY through a
 * TLS reverse proxy (443) with an IP allow-list for the admin host — never
 * publish the raw port. The HMAC auth above protects the secret even if
 * TLS terminates at the proxy.
 *
 * If `REZEIS_INTERNAL_SHARED_SECRET` is unset (dev / smoke tests) the
 * listener is skipped entirely — no auth means no endpoint, period.
 */
import * as http from 'node:http';

import type { Bot, Context } from 'grammy';
import { GrammyError, InlineKeyboard } from 'grammy';

import type { BotConfigCache } from '../../infrastructure/bot-config/cache.js';
import type { createLogger } from '../../infrastructure/logger/index.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  verifyInternalSignature,
} from '../../lib/internal-hmac.js';

interface ButtonInput {
  readonly text: string;
  readonly url?: string;
  readonly callbackData?: string;
}

interface NotifyPayload {
  readonly eventId?: unknown;
  readonly telegramId?: unknown;
  readonly text?: unknown;
  readonly parseMode?: unknown;
  readonly buttons?: unknown;
}

interface BroadcastPayload {
  readonly eventId?: unknown;
  readonly chatId?: unknown;
  readonly topicThreadId?: unknown;
  readonly text?: unknown;
  readonly parseMode?: unknown;
  readonly buttons?: unknown;
}

interface ListenerOptions {
  readonly bot: Bot<Context> | null;
  readonly cache: BotConfigCache | null;
  readonly secret: string | null;
  readonly port: number;
  readonly logger: ReturnType<typeof createLogger>;
  /**
   * Invoked when Telegram returns 403 Forbidden during a `/notify`
   * delivery. Lets the host record `isBotBlocked: true` on the user
   * so admin stops trying to deliver. Best-effort — failures swallowed.
   */
  readonly onUserBlocked?: (telegramId: string) => Promise<void> | void;
}

/**
 * Bounded LRU set of recently-seen event ids. Pure in-memory; a bot
 * restart drops the dedup cache and admin's own eventId guarantees
 * (CUID per write of UserNotificationEvent) cover what survives the
 * restart window. 1024 slots at 24h horizon is enough for typical
 * traffic — at 1 event/sec sustained we hit a ~17-min window but
 * normal volume is far lower.
 */
class IdempotencyCache {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly store = new Map<string, number>();

  public constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Atomic check-and-set: returns true when the id is new (caller
   * should proceed), false when it's a replay (caller should skip). */
  public claim(eventId: string): boolean {
    const now = Date.now();
    this.evictExpired(now);
    if (this.store.has(eventId)) return false;
    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(eventId, now);
    return true;
  }

  private evictExpired(now: number): void {
    // Single pass: Map iterators preserve insertion order, so the
    // first non-expired entry tells us when to stop.
    for (const [key, ts] of this.store) {
      if (now - ts < this.ttlMs) break;
      this.store.delete(key);
    }
  }
}

const IDEMPOTENCY_CACHE = new IdempotencyCache(1024, 24 * 60 * 60 * 1000);

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildKeyboard(input: unknown): InlineKeyboard | undefined {
  if (!Array.isArray(input)) return undefined;
  const kb = new InlineKeyboard();
  let placed = false;
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as ButtonInput;
    if (typeof item.text !== 'string' || item.text.length === 0) continue;
    if (typeof item.url === 'string' && item.url.length > 0) {
      kb.url(item.text, item.url);
      kb.row();
      placed = true;
    } else if (typeof item.callbackData === 'string' && item.callbackData.length > 0) {
      kb.text(item.text, item.callbackData);
      kb.row();
      placed = true;
    }
  }
  return placed ? kb : undefined;
}

function isValidParseMode(value: unknown): value is 'MarkdownV2' | 'HTML' {
  return value === 'MarkdownV2' || value === 'HTML';
}

export function startInternalHttpListener(opts: ListenerOptions): void {
  const { bot, cache, secret, port, logger, onUserBlocked } = opts;
  if (secret === null || secret.length === 0) {
    logger.info(
      'Internal HTTP listener disabled (REZEIS_INTERNAL_SHARED_SECRET unset)',
    );
    return;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const url = req.url ?? '';

    // Read the body up front (capped) so the HMAC can be verified over it
    // before we dispatch. 16 KiB covers the largest endpoint (broadcast).
    let raw: string;
    try {
      raw = await readBody(req, 16 * 1024);
    } catch {
      res.statusCode = 413;
      res.end();
      return;
    }

    if (!isAuthorized(req, url, raw, secret)) {
      logger.warn(
        { remoteAddress: req.socket.remoteAddress, path: url },
        'Internal listener: rejected (bad HMAC signature and X-Auth-Token)',
      );
      res.statusCode = 401;
      res.end();
      return;
    }

    try {
      if (url === '/invalidate') {
        await handleInvalidate(cache, logger, res);
        return;
      }
      if (url === '/notify') {
        await handleNotify({ bot, logger, raw, res, onUserBlocked });
        return;
      }
      if (url === '/notify-broadcast') {
        await handleBroadcast({ bot, logger, raw, res });
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (err: unknown) {
      logger.error({ err, path: url }, 'Internal listener handler crashed');
      res.statusCode = 500;
      res.end();
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Internal HTTP listener up');
  });
  server.on('error', (err) => {
    logger.error({ err, port }, 'Internal HTTP server error');
  });
}

/**
 * Accept the request when it carries a valid internal HMAC signature OR the
 * legacy `X-Auth-Token` shared secret. HMAC is preferred (secret never on the
 * wire, replay-bounded); the token path is transitional for same-host /
 * behind-TLS deployments until admin signs every call.
 */
function isAuthorized(
  req: http.IncomingMessage,
  path: string,
  body: string,
  secret: string,
): boolean {
  const timestamp = headerValue(req.headers[REQUEST_TIMESTAMP_HEADER]);
  const signature = headerValue(req.headers[REQUEST_SIGNATURE_HEADER]);
  if (timestamp !== undefined && signature !== undefined) {
    return verifyInternalSignature({
      secret,
      method: 'POST',
      path,
      body,
      timestamp,
      signature,
    });
  }
  // Legacy fallback: shared secret in the X-Auth-Token header.
  const token = req.headers['x-auth-token'];
  return typeof token === 'string' && token === secret;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

async function handleInvalidate(
  cache: BotConfigCache | null,
  logger: ReturnType<typeof createLogger>,
  res: http.ServerResponse,
): Promise<void> {
  if (cache === null) {
    logger.warn('Cache-invalidate: bot config cache not initialised yet');
    res.statusCode = 503;
    res.setHeader('Retry-After', '2');
    res.end();
    return;
  }
  try {
    const fresh = await cache.forceInvalidate('admin-pushed');
    res.statusCode = 204;
    res.end();
    logger.info({ hadRefresh: fresh !== null }, 'Cache-invalidate: succeeded');
  } catch (err: unknown) {
    logger.error({ err }, 'Cache-invalidate: forceInvalidate threw');
    res.statusCode = 500;
    res.end();
  }
}

interface NotifyHandlerOptions {
  readonly bot: Bot<Context> | null;
  readonly logger: ReturnType<typeof createLogger>;
  readonly raw: string;
  readonly res: http.ServerResponse;
  readonly onUserBlocked?: (telegramId: string) => Promise<void> | void;
}

async function handleNotify(opts: NotifyHandlerOptions): Promise<void> {
  const { bot, logger, raw, res, onUserBlocked } = opts;
  if (bot === null) {
    res.statusCode = 503;
    res.end();
    return;
  }
  let payload: NotifyPayload;
  try {
    payload = JSON.parse(raw) as NotifyPayload;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : null;
  const telegramId = typeof payload.telegramId === 'string' ? payload.telegramId : null;
  const text = typeof payload.text === 'string' ? payload.text : null;
  if (eventId === null || telegramId === null || text === null || text.length === 0) {
    res.statusCode = 400;
    res.end();
    return;
  }
  if (!/^\d{1,19}$/.test(telegramId)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  if (!IDEMPOTENCY_CACHE.claim(eventId)) {
    // Replay — admin re-fired but we already delivered. Tell the
    // caller success so they don't retry forever.
    res.statusCode = 204;
    res.end();
    return;
  }
  const parseMode = isValidParseMode(payload.parseMode) ? payload.parseMode : undefined;
  const reply_markup = buildKeyboard(payload.buttons);

  try {
    await bot.api.sendMessage(telegramId, text, {
      parse_mode: parseMode,
      reply_markup,
      // Most user-facing notifications shouldn't ping silently — let
      // Telegram apply the user's chat preferences. We don't override
      // disable_notification.
    });
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    if (err instanceof GrammyError && err.error_code === 403) {
      // User has blocked the bot or removed it from chat. Tell admin
      // so it can stop trying.
      logger.info({ telegramId, eventId }, 'Notify: user blocked the bot');
      try {
        await onUserBlocked?.(telegramId);
      } catch (blockErr: unknown) {
        logger.warn({ err: blockErr, telegramId }, 'Notify: onUserBlocked callback threw');
      }
      // Soft-success: from admin's POV the delivery decision is final.
      res.statusCode = 204;
      res.end();
      return;
    }
    logger.error({ err, eventId, telegramId }, 'Notify: sendMessage failed');
    res.statusCode = 502;
    res.end();
  }
}

interface BroadcastHandlerOptions {
  readonly bot: Bot<Context> | null;
  readonly logger: ReturnType<typeof createLogger>;
  readonly raw: string;
  readonly res: http.ServerResponse;
}

async function handleBroadcast(opts: BroadcastHandlerOptions): Promise<void> {
  const { bot, logger, raw, res } = opts;
  if (bot === null) {
    res.statusCode = 503;
    res.end();
    return;
  }
  let payload: BroadcastPayload;
  try {
    payload = JSON.parse(raw) as BroadcastPayload;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : null;
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : null;
  const text = typeof payload.text === 'string' ? payload.text : null;
  if (eventId === null || chatId === null || text === null || text.length === 0) {
    res.statusCode = 400;
    res.end();
    return;
  }
  if (!IDEMPOTENCY_CACHE.claim(eventId)) {
    res.statusCode = 204;
    res.end();
    return;
  }
  const parseMode = isValidParseMode(payload.parseMode) ? payload.parseMode : undefined;
  const reply_markup = buildKeyboard(payload.buttons);
  const messageThreadId = typeof payload.topicThreadId === 'number' && Number.isInteger(payload.topicThreadId)
    ? payload.topicThreadId
    : undefined;

  try {
    await bot.api.sendMessage(chatId, text, {
      parse_mode: parseMode,
      reply_markup,
      message_thread_id: messageThreadId,
    });
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    logger.error({ err, eventId, chatId }, 'Broadcast: sendMessage failed');
    res.statusCode = 502;
    res.end();
  }
}

