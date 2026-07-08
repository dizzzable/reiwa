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
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type { Bot, Context } from 'grammy';
import { GrammyError, InlineKeyboard, InputFile } from 'grammy';

import type { BotConfigCache } from '../../infrastructure/bot-config/cache.js';
import type { createLogger } from '../../infrastructure/logger/index.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import { renderButtonLabel, renderBotCopy, renderBotCopyHtml } from '../../infrastructure/bot-config/emoji-utils.js';
import type { BotEmojiMap, TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';
import { resolveBannerSource } from '../pages/banner-resolver.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  verifyInternalSignature,
} from '../../lib/internal-hmac.js';

interface ButtonInput {
  readonly text: string;
  readonly url?: string;
  readonly callbackData?: string;
  /**
   * Relative Mini App path (e.g. `/renew`). Resolved against the bot's own
   * `miniAppUrl` into a Telegram `web_app` inline button — opens the cabinet
   * directly at that route. Falls back to a plain URL button against
   * `publicWebUrl` when no Mini App URL is configured; dropped when neither is
   * available or the resolved URL isn't Telegram-safe (e.g. local dev).
   */
  readonly webAppPath?: string;
  /** Telegram Bot API 9.4 button color (premium-owner bots only). */
  readonly style?: 'primary' | 'success' | 'danger';
  /**
   * Optional 0-based row index. Buttons sharing a row render side-by-side;
   * omitted → the button falls on its own row (historical layout), so existing
   * notifications are unaffected.
   */
  readonly row?: number;
}

/** Resolved deep-link targets the keyboard builder anchors relative paths to. */
interface KeyboardUrls {
  readonly miniAppUrl?: string | null;
  readonly publicWebUrl?: string | null;
}

/**
 * Operator emoji registry + custom-emoji packs, so notification button labels
 * resolve `{{KEY}}` / `:slug:` tokens to glyphs and promote a leading premium
 * token to `icon_custom_emoji_id`. Sourced from the bot-config cache.
 */
interface NotifyEmojiContext {
  readonly botEmojis?: BotEmojiMap | null;
  readonly customEmojis?: Record<string, { id: string | null; fallback: string | null }> | null;
  readonly ownerHasPremium?: boolean;
}

interface NotifyPayload {
  readonly eventId?: unknown;
  readonly telegramId?: unknown;
  readonly text?: unknown;
  readonly parseMode?: unknown;
  readonly buttons?: unknown;
  readonly bannerUrl?: unknown;
}

interface BroadcastPayload {
  readonly eventId?: unknown;
  readonly chatId?: unknown;
  readonly topicThreadId?: unknown;
  readonly text?: unknown;
  readonly parseMode?: unknown;
  readonly buttons?: unknown;
}

interface DevNotifyPayload {
  readonly text?: unknown;
  readonly parseMode?: unknown;
}

interface DevNotifyDocumentPayload {
  readonly filename?: unknown;
  readonly content?: unknown;
  readonly caption?: unknown;
  readonly parseMode?: unknown;
}

interface BackupDocumentPayload {
  readonly recordId?: unknown;
  readonly token?: unknown;
  readonly filename?: unknown;
  readonly caption?: unknown;
  readonly chatId?: unknown;
  readonly topicThreadId?: unknown;
}

interface ListenerOptions {
  readonly bot: Bot<Context> | null;
  readonly cache: BotConfigCache | null;
  readonly secret: string | null;
  readonly port: number;
  readonly logger: ReturnType<typeof createLogger>;
  /**
   * Telegram id of the bot's developer/operator (`BOT_DEV_ID`). Target of the
   * `/notify-dev` endpoint — lets rezeis route system events to the dev's DM
   * automatically when no operator group/topic is configured, without rezeis
   * ever knowing the dev id. `undefined` → `/notify-dev` is a no-op.
   */
  readonly devId?: number;
  /**
   * Invoked when Telegram returns 403 Forbidden during a `/notify`
   * delivery. Lets the host record `isBotBlocked: true` on the user
   * so admin stops trying to deliver. Best-effort — failures swallowed.
   */
  readonly onUserBlocked?: (telegramId: string) => Promise<void> | void;
  /**
   * Admin base URL (`http://rezeis:8000` or `https://admin.example.com`) used
   * by `/notify-backup-document` to fetch a backup file from rezeis (signed
   * download URL) and upload it to Telegram. `null` disables that endpoint.
   */
  readonly rezeisAdminUrl?: string | null;
  /**
   * Deep-link targets the keyboard builder anchors relative button paths to
   * (`webAppPath`). The bot owns these (it knows its own Mini App URL); rezeis
   * sends only the relative path so it stays decoupled from the bot username /
   * public Mini App URL.
   */
  readonly keyboardUrls?: KeyboardUrls;
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

function buildKeyboard(
  input: unknown,
  urls?: KeyboardUrls,
  emoji?: NotifyEmojiContext,
): InlineKeyboard | undefined {
  if (!Array.isArray(input)) return undefined;
  const kb = new InlineKeyboard();
  let placed = false;
  // Row-aware layout: buttons carrying the same `row` index render side-by-side.
  // A button without a `row` falls back to its position in the array, so each
  // such button lands on its own row — identical to the historical layout when
  // no rows are configured. We stable-sort by effective row first (so rows
  // group even when the operator listed them out of order), then `beginButton`
  // emits a Telegram row break only when a real button is about to be placed
  // AND the row changed — dropped buttons (unsafe/unresolved URLs) never leave
  // an empty row behind.
  let lastRow: number | null = null;
  const rowOf = (item: ButtonInput, fallback: number): number =>
    typeof item.row === 'number' && Number.isInteger(item.row) && item.row >= 0
      ? item.row
      : fallback;
  const ordered = input
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => raw !== null && typeof raw === 'object')
    .map(({ raw, i }) => ({ item: raw as ButtonInput, eff: rowOf(raw as ButtonInput, i) }))
    .sort((a, b) => a.eff - b.eff);
  const beginButton = (rowIdx: number): void => {
    if (placed && rowIdx !== lastRow) kb.row();
    lastRow = rowIdx;
    placed = true;
  };
  // Resolve `{{KEY}}` / `:slug:` tokens in the label to glyphs and promote a
  // leading premium token to the button's `icon_custom_emoji_id` — same
  // contract the bot keyboards use, so notification buttons render premium
  // pack emoji instead of leaking the raw `:slug:` text.
  const labelArg = (
    text: string,
    style?: 'primary' | 'success' | 'danger',
  ): string | { text: string; icon_custom_emoji_id?: string; style?: 'primary' | 'success' | 'danger' } => {
    const r = renderButtonLabel(
      text,
      emoji?.botEmojis,
      emoji?.customEmojis,
      emoji?.ownerHasPremium ?? true,
    );
    if (r.iconCustomEmojiId === undefined && style === undefined) return r.text;
    const out: { text: string; icon_custom_emoji_id?: string; style?: 'primary' | 'success' | 'danger' } = {
      text: r.text,
    };
    if (r.iconCustomEmojiId !== undefined) out.icon_custom_emoji_id = r.iconCustomEmojiId;
    if (style !== undefined) out.style = style;
    return out;
  };
  for (const { item, eff } of ordered) {
    if (typeof item.text !== 'string' || item.text.length === 0) continue;
    const textArg = labelArg(item.text, item.style);
    // Mini App deep-link button — opens the cabinet straight on a route.
    if (typeof item.webAppPath === 'string' && item.webAppPath.length > 0) {
      const path = item.webAppPath.startsWith('/') ? item.webAppPath : `/${item.webAppPath}`;
      const miniAppUrl = urls?.miniAppUrl ?? null;
      const publicWebUrl = urls?.publicWebUrl ?? null;
      const webAppUrl = miniAppUrl !== null ? `${miniAppUrl.replace(/\/+$/, '')}${path}` : null;
      if (webAppUrl !== null && isTelegramSafeButtonUrl(webAppUrl)) {
        beginButton(eff);
        kb.webApp(textArg, webAppUrl);
        continue;
      }
      // Fallback: plain URL button to the public web (in-app browser).
      const fallbackUrl = publicWebUrl !== null ? `${publicWebUrl.replace(/\/+$/, '')}${path}` : null;
      if (fallbackUrl !== null && isTelegramSafeButtonUrl(fallbackUrl)) {
        beginButton(eff);
        kb.url(textArg, fallbackUrl);
      }
      // Neither target available (dev / unconfigured) → drop silently.
      continue;
    }
    if (typeof item.url === 'string' && item.url.length > 0) {
      beginButton(eff);
      kb.url(textArg, item.url);
    } else if (typeof item.callbackData === 'string' && item.callbackData.length > 0) {
      beginButton(eff);
      kb.text(textArg, item.callbackData);
    }
  }
  return placed ? kb : undefined;
}

function isValidParseMode(value: unknown): value is 'MarkdownV2' | 'HTML' {
  return value === 'MarkdownV2' || value === 'HTML';
}

/**
 * Best-effort emoji context from the bot-config cache for notification button
 * labels. Returns `undefined` when no cache is wired or a read fails — labels
 * then render verbatim (graceful degradation).
 */
async function resolveEmojiContext(
  cache: BotConfigCache | null | undefined,
): Promise<NotifyEmojiContext | undefined> {
  if (cache === null || cache === undefined) return undefined;
  try {
    const cfg = await cache.get();
    return {
      botEmojis: cfg.botEmojis,
      customEmojis: cfg.customEmojis,
      ownerHasPremium: cfg.botEmojiOwnerHasPremium,
    };
  } catch {
    return undefined;
  }
}

/**
 * Render a notification/broadcast BODY with the operator emoji registry so
 * premium/custom emoji tokens (`{{KEY}}`, `:slug:`) in the message text render
 * as real Telegram custom emoji — mirroring the screen/reply send paths.
 * Previously the registry was applied only to button labels, so tokens in the
 * body leaked as literal text (e.g. `:translucentpack_9:`) or degraded to
 * plain unicode.
 *
 *  - `HTML` parse mode → `<tg-emoji>` tags via `renderBotCopyHtml`.
 *  - otherwise → `custom_emoji` entities via `renderBotCopy`. Entity mode needs
 *    plain text, so we only drop the parse mode when entities are actually
 *    produced; when none are (no premium emoji), the resolved unicode text is
 *    returned with the original parse mode intact.
 */
function renderNotifyBody(
  text: string,
  parseMode: 'HTML' | 'Markdown' | 'MarkdownV2' | undefined,
  emojiCtx: NotifyEmojiContext | undefined,
): { text: string; parseMode: 'HTML' | 'Markdown' | 'MarkdownV2' | undefined; entities: TgCustomEmojiEntity[] | undefined } {
  if (emojiCtx === undefined) {
    return { text, parseMode, entities: undefined };
  }
  const ownerHasPremium = emojiCtx.ownerHasPremium ?? true;
  if (parseMode === 'HTML') {
    return {
      text: renderBotCopyHtml(text, emojiCtx.botEmojis, emojiCtx.customEmojis, ownerHasPremium),
      parseMode: 'HTML',
      entities: undefined,
    };
  }
  const rendered = renderBotCopy(text, emojiCtx.botEmojis, emojiCtx.customEmojis, ownerHasPremium);
  if (rendered.entities.length > 0) {
    // Custom-emoji entities can't coexist with a parse_mode — send plain text
    // carrying the entities.
    return { text: rendered.text, parseMode: undefined, entities: rendered.entities };
  }
  // No premium entities: keep the caller's parse mode; tokens are already
  // resolved to their unicode/fallback glyphs so nothing leaks as literal.
  return { text: rendered.text, parseMode, entities: undefined };
}

export function startInternalHttpListener(opts: ListenerOptions): void {
  const { bot, cache, secret, port, logger, onUserBlocked, devId, rezeisAdminUrl, keyboardUrls } = opts;
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
        await handleNotify({ bot, logger, raw, res, onUserBlocked, keyboardUrls, rezeisAdminUrl: rezeisAdminUrl ?? null, cache });
        return;
      }
      if (url === '/notify-dev') {
        await handleNotifyDev({ bot, devId, logger, raw, res });
        return;
      }
      if (url === '/notify-dev-document') {
        await handleNotifyDevDocument({ bot, devId, logger, raw, res });
        return;
      }
      if (url === '/notify-backup-document') {
        await handleNotifyBackupDocument({ bot, logger, raw, res, rezeisAdminUrl: rezeisAdminUrl ?? null });
        return;
      }
      if (url === '/notify-broadcast') {
        await handleBroadcast({ bot, logger, raw, res, keyboardUrls, cache });
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
  readonly keyboardUrls?: KeyboardUrls;
  readonly rezeisAdminUrl?: string | null;
  readonly cache?: BotConfigCache | null;
}

interface DevNotifyHandlerOptions {
  readonly bot: Bot<Context> | null;
  readonly devId?: number;
  readonly logger: ReturnType<typeof createLogger>;
  readonly raw: string;
  readonly res: http.ServerResponse;
}

/**
 * `/notify-dev` — deliver a system-event card to the bot's developer/operator
 * (`BOT_DEV_ID`). Used by rezeis as the automatic fallback when no operator
 * group/topic is configured: the message lands in the dev's private DM with
 * this same bot, so it's visible only to them. No-ops (204) when the bot or
 * `BOT_DEV_ID` isn't available, so a misconfigured deployment never errors.
 */
async function handleNotifyDev(opts: DevNotifyHandlerOptions): Promise<void> {
  const { bot, devId, logger, raw, res } = opts;
  if (bot === null || devId === undefined) {
    res.statusCode = 204;
    res.end();
    return;
  }
  let payload: DevNotifyPayload;
  try {
    payload = JSON.parse(raw) as DevNotifyPayload;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const text = typeof payload.text === 'string' ? payload.text : null;
  if (text === null || text.length === 0) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const parseMode = isValidParseMode(payload.parseMode) ? payload.parseMode : undefined;
  // Universal "Close" button so the dev can dismiss a handled event card
  // (routed by the shared `close` callback → deletes the message).
  const keyboard = new InlineKeyboard().text('❌ Закрыть', 'close');
  try {
    await bot.api.sendMessage(devId, text, {
      ...(parseMode !== undefined ? { parse_mode: parseMode } : {}),
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    logger.warn({ err, devId }, 'Notify-dev: send failed');
    // Soft-success: the firehose is best-effort; don't make admin retry.
    res.statusCode = 204;
    res.end();
  }
}

/** Telegram caption hard limit (1024). HTML entities are not counted, but we
 *  trim defensively so a verbose error message can never make the send fail. */
const TG_CAPTION_LIMIT = 1024;

/**
 * `/notify-dev-document` — deliver an `.txt` error report (e.g. `error_0.txt`)
 * to the bot's developer/operator (`BOT_DEV_ID`) as a Telegram document, with
 * the sectioned error card carried as the document caption and a universal
 * "❌ Закрыть" (`close`) button. This is the dev-DM analogue of the operator
 * group's error report and matches the agreed card layout. No-ops (204) when
 * the bot or `BOT_DEV_ID` isn't available.
 */
async function handleNotifyDevDocument(opts: DevNotifyHandlerOptions): Promise<void> {
  const { bot, devId, logger, raw, res } = opts;
  if (bot === null || devId === undefined) {
    res.statusCode = 204;
    res.end();
    return;
  }
  let payload: DevNotifyDocumentPayload;
  try {
    payload = JSON.parse(raw) as DevNotifyDocumentPayload;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const content = typeof payload.content === 'string' ? payload.content : null;
  if (content === null || content.length === 0) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const filename =
    typeof payload.filename === 'string' && payload.filename.trim().length > 0
      ? payload.filename.trim()
      : 'error.txt';
  const captionRaw = typeof payload.caption === 'string' ? payload.caption : undefined;
  const caption =
    captionRaw !== undefined && captionRaw.length > TG_CAPTION_LIMIT
      ? captionRaw.slice(0, TG_CAPTION_LIMIT)
      : captionRaw;
  const parseMode = isValidParseMode(payload.parseMode) ? payload.parseMode : undefined;
  const keyboard = new InlineKeyboard().text('❌ Закрыть', 'close');
  try {
    const document = new InputFile(Buffer.from(content, 'utf8'), filename);
    await bot.api.sendDocument(devId, document, {
      ...(caption !== undefined ? { caption } : {}),
      ...(parseMode !== undefined ? { parse_mode: parseMode } : {}),
      reply_markup: keyboard,
    });
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    logger.warn({ err, devId }, 'Notify-dev-document: send failed');
    // Soft-success: the firehose is best-effort; don't make admin retry.
    res.statusCode = 204;
    res.end();
  }
}

/**
 * `/notify-backup-document` — fetch a backup file from rezeis (signed download
 * URL) and upload it to the configured Telegram chat/topic. Used on the split
 * deployment where rezeis has no bot token: rezeis hands the bot a short-lived
 * token, the bot pulls the bytes over the docker hop and re-uploads them.
 * Best-effort.
 */
async function handleNotifyBackupDocument(opts: {
  readonly bot: Bot<Context> | null;
  readonly logger: ReturnType<typeof createLogger>;
  readonly raw: string;
  readonly res: http.ServerResponse;
  readonly rezeisAdminUrl: string | null;
}): Promise<void> {
  const { bot, logger, raw, res, rezeisAdminUrl } = opts;
  if (bot === null || rezeisAdminUrl === null) {
    res.statusCode = 204;
    res.end();
    return;
  }
  let payload: BackupDocumentPayload;
  try {
    payload = JSON.parse(raw) as BackupDocumentPayload;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const recordId = typeof payload.recordId === 'string' ? payload.recordId : null;
  const token = typeof payload.token === 'string' ? payload.token : null;
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : null;
  if (recordId === null || token === null || chatId === null) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const filename =
    typeof payload.filename === 'string' && payload.filename.trim().length > 0
      ? payload.filename.trim()
      : 'backup.sql.gz';
  const captionRaw = typeof payload.caption === 'string' ? payload.caption : undefined;
  const caption =
    captionRaw !== undefined && captionRaw.length > TG_CAPTION_LIMIT
      ? captionRaw.slice(0, TG_CAPTION_LIMIT)
      : captionRaw;
  const topicThreadId =
    typeof payload.topicThreadId === 'number' ? payload.topicThreadId : undefined;
  const downloadUrl =
    `${rezeisAdminUrl.replace(/\/+$/, '')}/api/internal/backups/download` +
    `?recordId=${encodeURIComponent(recordId)}&token=${encodeURIComponent(token)}`;
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok || response.body === null) {
      logger.warn({ status: response.status, recordId }, 'Notify-backup-document: fetch failed');
      res.statusCode = 204;
      res.end();
      return;
    }
    // Stream the file straight through to Telegram instead of buffering — a
    // 2 GB backup (Local Bot API Server) must never be held in memory.
    const stream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    const document = new InputFile(stream, filename);
    await bot.api.sendDocument(chatId, document, {
      ...(caption !== undefined ? { caption } : {}),
      ...(topicThreadId !== undefined ? { message_thread_id: topicThreadId } : {}),
    });
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    logger.warn({ err, recordId }, 'Notify-backup-document: send failed');
    // Soft-success: delivery is best-effort; don't make admin retry forever.
    res.statusCode = 204;
    res.end();
  }
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
  const rawParseMode = isValidParseMode(payload.parseMode) ? payload.parseMode : undefined;
  const emojiCtx = await resolveEmojiContext(opts.cache);
  const reply_markup = buildKeyboard(payload.buttons, opts.keyboardUrls, emojiCtx);
  // Render premium/custom emoji in the BODY (not just button labels).
  const body = renderNotifyBody(text, rawParseMode, emojiCtx);
  const parseMode = body.parseMode;
  const bannerUrl =
    typeof payload.bannerUrl === 'string' && payload.bannerUrl.trim().length > 0
      ? payload.bannerUrl.trim()
      : null;

  try {
    let sent: { message_id: number } | undefined;
    // Banner-tagged notification → send as a photo with the text as caption
    // (Telegram caption limit 1024). Relative `/uploads/...` URLs are fetched
    // from rezeis by the resolver. Any photo failure falls back to text so a
    // banner glitch never drops the notification.
    if (bannerUrl !== null && body.text.length <= TG_CAPTION_LIMIT) {
      const photo = await resolveBannerSource(bannerUrl, {
        rezeisAdminUrl: opts.rezeisAdminUrl ?? null,
        logger: { warn: (o, m) => opts.logger.warn(o as Record<string, unknown>, m) },
      });
      if (photo !== null) {
        try {
          sent = await bot.api.sendPhoto(telegramId, photo, {
            caption: body.text,
            parse_mode: parseMode,
            caption_entities: body.entities,
            reply_markup,
          });
        } catch (photoErr: unknown) {
          if (photoErr instanceof GrammyError && photoErr.error_code === 403) throw photoErr;
          opts.logger.warn(
            { err: photoErr, telegramId },
            'Notify: sendPhoto failed; falling back to text',
          );
        }
      }
    }
    if (sent === undefined) {
      sent = await bot.api.sendMessage(telegramId, body.text, {
        parse_mode: parseMode,
        entities: body.entities,
        reply_markup,
        // Most user-facing notifications shouldn't ping silently — let
        // Telegram apply the user's chat preferences. We don't override
        // disable_notification.
      });
    }
    // Return the Telegram message id so admin can persist it and later
    // edit/delete the message within Telegram's 48h edit window.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ messageId: sent.message_id }));
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
  readonly keyboardUrls?: KeyboardUrls;
  readonly cache?: BotConfigCache | null;
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
  const rawParseMode = isValidParseMode(payload.parseMode) ? payload.parseMode : undefined;
  const emojiCtx = await resolveEmojiContext(opts.cache);
  const reply_markup = buildKeyboard(payload.buttons, opts.keyboardUrls, emojiCtx);
  // Render premium/custom emoji in the broadcast BODY (not just buttons).
  const body = renderNotifyBody(text, rawParseMode, emojiCtx);
  const messageThreadId = typeof payload.topicThreadId === 'number' && Number.isInteger(payload.topicThreadId)
    ? payload.topicThreadId
    : undefined;

  try {
    await bot.api.sendMessage(chatId, body.text, {
      parse_mode: body.parseMode,
      entities: body.entities,
      reply_markup,
      message_thread_id: messageThreadId,
    });
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    // Permanent client errors (chat not found / bot not in chat / bad topic
    // id) won't be fixed by a retry — they mean the operator's Chat ID / topic
    // is wrong. Ack (204) so the admin side doesn't escalate to a 502 cascade,
    // and log a concise warning instead of a full stack trace.
    if (err instanceof GrammyError && err.error_code >= 400 && err.error_code < 500) {
      logger.warn(
        { eventId, chatId, code: err.error_code, description: err.description },
        'Broadcast: permanent delivery failure — check Chat ID / topic id / bot membership',
      );
      res.statusCode = 204;
      res.end();
      return;
    }
    logger.error({ err, eventId, chatId }, 'Broadcast: sendMessage failed');
    res.statusCode = 502;
    res.end();
  }
}

