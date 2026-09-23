/**
 * Internal HTTP listener — single Node-native server bound to
 * `BOT_INVALIDATE_PORT` (default 5100). Exposes a narrow set of endpoints to
 * ONE caller, reiwa-api. The panel never dials the bot: it delivers signed
 * webhooks to reiwa-api's public `/api/v1/webhooks/rezeis`
 * (`api/routes/webhooks.ts`), and reiwa-api relays each action here over the
 * compose network the two containers share on one host.
 *
 * Auth (either is accepted):
 *   - HMAC signature (preferred): `x-request-timestamp` + `x-request-signature`
 *     over `METHOD\nPATH\nTIMESTAMP\nsha256(body)` keyed with
 *     `REZEIS_INTERNAL_SHARED_SECRET` (see `lib/internal-hmac.ts`). The
 *     secret never travels on the wire and a stale timestamp is rejected.
 *     reiwa-api signs every relay this way.
 *   - Legacy shared-secret header `X-Auth-Token` == `REZEIS_INTERNAL_SHARED_SECRET`
 *     (left from when the panel called the bot directly; nothing sends it any
 *     more, and it is still accepted until it is removed in a change of its own).
 *
 * Endpoints:
 *
 *   POST /invalidate
 *     Force-refresh the in-process bot config cache. reiwa-api relays
 *     `reiwa.bot.invalidate` here, which the panel sends whenever an operator
 *     saves the BotConfig, so the next user request sees fresh data without
 *     waiting up to 5 min for the periodic refresh.
 *
 *   POST /invalidate-policy
 *     Drop this process's platform-policy and legal-documents caches.
 *     reiwa-api relays `reiwa.platform.policy_invalidated` here (the access
 *     mode or a legal document changed): those caches are per-process and
 *     the webhook lands in the API, so nothing it drops there reaches the
 *     bot. Always 204.
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
 *     `eventId`s (24h horizon). A repeat of a delivered event sends nothing
 *     and answers as the delivery did; a repeat that arrives while the first
 *     send is still out answers 503 + Retry-After. A send that failed keeps
 *     no claim, so its repeat is sent.
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
 *   POST /notify-broadcast-document
 *     Deliver a text document with an optional HTML/Markdown caption to a
 *     chat / topic. Used for full error reports on split deployments.
 *
 *   POST /notify-dev, /notify-dev-document, /notify-backup-document
 *     Described at their handlers below.
 *
 *   When Telegram does not take the message, every route above except the
 *   backup relay answers by one table — 422 refused, 503 + Retry-After for a
 *   flood-wait, 502 for an outage, 424 for a dev route with no `BOT_DEV_ID` —
 *   and `/notify` keeps 204 for a subscriber who blocked or never started the
 *   bot. Every failed send gives its event id back, so the panel's retry sends
 *   again. The reasoning, and what the panel does with each, is at
 *   `TELEGRAM_REFUSED_STATUS`.
 *
 * Bound to `0.0.0.0` INSIDE the bot container, and never published on any
 * topology: no compose file maps this port, and none should. reiwa-api reaches
 * it as `REIWA_BOT_INTERNAL_URL` (default `http://reiwa-bot:5100`), and
 * reiwa-api and reiwa-bot always run side by side on one host — splitting the
 * panel and the cabinet across VPSes moves `REZEIS_HOST`, never this hop
 * (`.env.example`). Publishing the port, behind a proxy or not, would reach no
 * caller that is not already on that network, and would put on the internet a
 * listener that reads a request body before it checks auth.
 *
 * If `REZEIS_INTERNAL_SHARED_SECRET` is unset (dev / smoke tests) the
 * listener is skipped entirely — no auth means no endpoint, period.
 */
import * as http from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type { Bot, Context } from 'grammy';
import { GrammyError, InlineKeyboard, InputFile } from 'grammy';

import { invalidateLegalDocumentsCache } from '../../infrastructure/admin-client/legal-documents-cache.js';
import { invalidatePolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import type { BotConfigCache } from '../../infrastructure/bot-config/cache.js';
import type { createLogger } from '../../infrastructure/logger/index.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import { htmlCopy, markdownCopy, markdownV2Copy, messageCopy } from '../widgets/operator-copy.js';
import { loggableTelegramError } from './telegram-error-log.js';
import { renderButtonLabel } from '../../infrastructure/bot-config/emoji-utils.js';
import type { BotConfig, BotEmojiMap, TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';
import { resolveBannerSource } from '../pages/banner-resolver.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  timingSafeStringEqual,
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

interface BroadcastDocumentPayload {
  readonly eventId?: unknown;
  readonly chatId?: unknown;
  readonly filename?: unknown;
  readonly content?: unknown;
  readonly caption?: unknown;
  readonly topicThreadId?: unknown;
  readonly parseMode?: unknown;
}

interface DevNotifyPayload {
  readonly eventId?: unknown;
  readonly text?: unknown;
  readonly parseMode?: unknown;
}

interface DevNotifyDocumentPayload {
  readonly eventId?: unknown;
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
   * ever knowing the dev id. `undefined` → both dev routes answer 424, so the
   * panel records the card as undelivered instead of as sent.
   */
  readonly devId?: number;
  /**
   * Called with the freshly fetched config after a successful `/invalidate`.
   * This is where anything that has to be PUSHED to Telegram on a config
   * change belongs — the bot profile, the slash-command list — because a cache
   * refresh alone changes what the bot READS, not what Telegram already holds.
   *
   * Invoked after the 204 is written, and never awaited: rezeis gives the
   * synchronous variant of this call a five-second budget, and Bot API round
   * trips have no business inside it.
   */
  readonly onConfigApplied?: (config: BotConfig) => void | Promise<void>;
  /**
   * Invoked when Telegram returns 403 Forbidden during a `/notify`
   * delivery. Lets the host record `isBotBlocked: true` on the user
   * so admin stops trying to deliver. Best-effort — a failure is logged.
   *
   * The 204 waits for it, up to `USER_BLOCKED_REPORT_WAIT_MS`: see there for
   * why it must be awaited and why it must be capped.
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
 * What a replay of an already-claimed event is told.
 *
 * Two states, because "the id is taken" used to be answered as one: a 204, as
 * if delivered. A claim is taken BEFORE the send, so while that send is still
 * out the outcome is not known yet — reiwa-api gives up on the hop after 8s,
 * the panel retries 15s later, and a Telegram call can take longer than both. A
 * replay answered "delivered" then recorded an operator card as posted that
 * could still fail a minute later, with no attempt left to repeat it.
 */
type ReplayState =
  /** The first send has not settled yet: ask again later. */
  | { readonly kind: 'in-flight' }
  /** Telegram took the message. `messageId` when the route keeps Telegram's id. */
  | { readonly kind: 'delivered'; readonly messageId: number | undefined };

/** One claimed event id. */
interface ClaimEntry {
  /** When the id was claimed; the 24h horizon counts from here. */
  readonly at: number;
  state: 'in-flight' | 'delivered';
  /** Telegram's own id, on the routes that keep it. */
  messageId?: number;
}

/**
 * Bounded LRU set of recently-seen event ids. Pure in-memory; a bot
 * restart drops the dedup cache and admin's own eventId guarantees
 * (CUID per write of UserNotificationEvent) cover what survives the
 * restart window. 1024 slots at 24h horizon is enough for typical
 * traffic — at 1 event/sec sustained we hit a ~17-min window but
 * normal volume is far lower.
 *
 * A claim lives exactly as long as it guards a message that exists or is on
 * its way: taken before the send, SETTLED when Telegram took it, RELEASED when
 * the send failed in any way. See `release` for why a failure gives it back.
 */
class IdempotencyCache {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  /**
   * Remembering Telegram's id is what lets a REPLAY answer with proof. Without
   * it a replay answered a bodiless 204, the panel read that as "accepted,
   * nothing claimed", and its rule for a user notification — which demands
   * proof — recorded a FAILURE for somebody who had already received the
   * message. A relay hiccup therefore wrote off every recipient it had in
   * flight, permanently, and pressing "retry" only reproduced it.
   */
  private readonly store = new Map<string, ClaimEntry>();

  public constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Atomic check-and-set: returns true when the id is new (caller
   * should proceed), false when it's a replay (caller asks `replayOf`). */
  public claim(eventId: string): boolean {
    const now = Date.now();
    this.evictExpired(now);
    if (this.store.has(eventId)) return false;
    if (this.store.size >= this.maxSize) this.evictOldestDelivered();
    this.store.set(eventId, { at: now, state: 'in-flight' });
    return true;
  }

  /** Marks the claimed send as delivered, keeping Telegram's id when there is one. */
  public settle(eventId: string, messageId?: number): void {
    const entry = this.store.get(eventId);
    if (entry === undefined) return;
    entry.state = 'delivered';
    if (messageId !== undefined) entry.messageId = messageId;
  }

  /**
   * What a replay of `eventId` should be told. Meaningful right after `claim`
   * returned false; an id that is not held reads as in flight, which only ever
   * costs the caller one more attempt.
   */
  public replayOf(eventId: string): ReplayState {
    const entry = this.store.get(eventId);
    if (entry === undefined || entry.state === 'in-flight') return { kind: 'in-flight' };
    return { kind: 'delivered', messageId: entry.messageId };
  }

  /**
   * Gives a claim back after the send it guarded failed — every failure.
   *
   * A claim taken BEFORE the send and never released turns the retry policy
   * into a single attempt: the second delivery of the same event finds the id
   * present, skips the send, and answers as though it had done the work. The
   * claim exists to stop a DUPLICATE send, not to stop a RETRY of one that
   * never happened. A refusal (a 4xx from Telegram) produced no message either,
   * so holding its claim protects nothing and makes a later delivery of the
   * same id — the operator fixed the chat and pressed retry — answer "done"
   * without sending.
   *
   * That includes the failures after which Telegram MAY have the message — a
   * reset once the request was written, grammY's deadline, a 5xx. Holding
   * those was tried: their retry was answered `unconfirmed`, which the panel
   * records as DELIVERED for every event but a user notification, so an outage
   * that failed sends this way recorded every operator card as posted, sent
   * none and alerted nobody. They are also rarely a delivery in fact: this bot
   * leaves grammY's call deadline at 500s, so a request Telegram did process
   * but never answered stays in flight far past the panel's retries, and what
   * does fail inside them — resets, TLS failures, HTML or JSON 5xx — almost
   * always sent nothing. At least once: a rare second copy, not a lost message.
   */
  public release(eventId: string): void {
    this.store.delete(eventId);
  }

  /**
   * Makes room for one claim by dropping the oldest DELIVERED entry — never
   * one still in flight.
   *
   * An in-flight entry is all that stops a replay from sending the same message
   * while the first send is still out. Dropped, the replay sends a second copy,
   * and the first send's late `settle` or `release` then lands on the replay's
   * claim instead of its own. A delivered entry only costs a later replay its
   * dedup — that replay sends again, as it would after a bot restart.
   *
   * In-flight entries are bounded by how many sends run at once, so when every
   * entry is in flight the map grows past `maxSize` for as long as they last
   * rather than drop one. The walk from the oldest end passes over at most that
   * many before it finds a delivered entry.
   */
  private evictOldestDelivered(): void {
    for (const [key, entry] of this.store) {
      if (entry.state === 'delivered') {
        this.store.delete(key);
        return;
      }
    }
  }

  private evictExpired(now: number): void {
    // Single pass: Map iterators preserve insertion order, so the
    // first non-expired entry tells us when to stop. Whatever the state: no
    // send is in flight for 24h — grammY gives a call up after 500s — so an
    // in-flight entry this old is a claim nothing will ever settle.
    for (const [key, entry] of this.store) {
      if (now - entry.at < this.ttlMs) break;
      this.store.delete(key);
    }
  }
}

const IDEMPOTENCY_CACHE = new IdempotencyCache(1024, 24 * 60 * 60 * 1000);

/** The outcome of `claimDevEvent`. */
type DevClaim =
  /** No usable key: deliver, without dedup. */
  | { readonly kind: 'unkeyed' }
  /** Claimed under `key`, which the caller settles or releases. */
  | { readonly kind: 'claimed'; readonly key: string }
  /** Already claimed: answer the replay instead of sending. */
  | { readonly kind: 'replay'; readonly replay: ReplayState };

/**
 * Claim an OPTIONAL dedup key for one of the two dev-fallback endpoints.
 * Returns `replay` when this exact delivery is already made or under way, and
 * the caller should answer that instead of sending again.
 *
 * Two things differ from `/notify`, `/notify-broadcast` and
 * `/notify-broadcast-document`, which read `eventId` inline and 400 without it:
 *
 * 1. A MISSING key is accepted and simply skips the dedup. rezeis only started
 *    stamping these two events after the relay queue landed; a panel older than
 *    that sends `{ text, parseMode }` with no id at all, and 400-ing it would
 *    silence the dev firehose during the incident it exists to report. That's
 *    the same delivery this endpoint made before the key existed, so an old
 *    panel keeps working unchanged — it just keeps the duplicate it had.
 *
 * 2. The key is SCOPED to the endpoint. The cache is one keyspace shared by all
 *    five senders, and the card and its attached `.txt` report are two halves of
 *    one system event — if the panel ever stamps both halves with that event’s
 *    id (the operator pair suffixes them, `<id>:error-report`, but nothing
 *    forces that here), an unscoped claim would let the card swallow the
 *    document. Scoping cannot cost a dedup: a replay of one endpoint still
 *    collides with itself.
 */
function claimDevEvent(scope: string, eventId: unknown): DevClaim {
  if (typeof eventId !== 'string') return { kind: 'unkeyed' };
  const trimmed = eventId.trim();
  if (trimmed.length === 0) return { kind: 'unkeyed' };
  const key = `${scope}:${trimmed}`;
  return IDEMPOTENCY_CACHE.claim(key)
    ? { kind: 'claimed', key }
    : { kind: 'replay', replay: IDEMPOTENCY_CACHE.replayOf(key) };
}

/**
 * ── What a notify route answers when Telegram does not take the message ──
 *
 * The status is the only thing that crosses back, and it crosses two hops:
 * reiwa-api's webhook router translates it (`api/routes/webhooks.ts`), and
 * the panel acts on the translation. The panel's rules, which these statuses
 * are chosen against (rezeis-admin, `bot-notifier.client.ts`,
 * `reiwa-relay.policy.ts`, `reiwa-relay.processor.ts`,
 * `backup-delivery-retry.util.ts`):
 *
 *   - any 2xx without a numeric `messageId` is `unconfirmed`, and
 *     `unconfirmed` counts as DELIVERED for every event but a user
 *     notification — so a 2xx for a failure records it as a success;
 *   - a non-2xx is `rejected`: retried when it is a 5xx, 408 or 429 — no
 *     sooner than a `Retry-After` it names (`resolveRelayBackoff`, capped at
 *     15 minutes) — otherwise terminal and undelivered. An undelivered event is
 *     alerted (`reiwa.relay_undelivered`, coalesced per cause), except a user
 *     notification's `unconfirmed` and a dev route that reached nobody — its
 *     424, or a 422 whose reason says the RECIPIENT refused (chat not found, the
 *     bot blocked or not in the chat) — which the panel completes quietly
 *     (`shouldAlertOperator`, `isDevRelayDeadEnd`). A dev route's 422 for the
 *     MESSAGE itself (unparsable entities, too long) is recorded and alerted.
 *
 * Hence:
 *
 *   - `TELEGRAM_REFUSED_STATUS` (422) — Telegram refused THIS message: chat not
 *     found, bot not in the chat, message too long, unparsable entities. The
 *     same request is refused identically in fifteen seconds, so terminal.
 *     Alerted on an operator or subscriber route. On a dev route the panel
 *     reads the `error` text: a recipient refusal is a quiet dead end, since
 *     the alert would take the same route to the same refusal; a refusal of the
 *     message itself is alerted. So the reason must stay in the body.
 *   - `RETRY_LATER_STATUS` (503) + `Retry-After` — Telegram's 429 flood-wait,
 *     and a replay of a send that is still out. `classifyTelegramFailure`
 *     checks for 429 BEFORE the generic 4xx bucket: a 429 is the one refusal
 *     that means "later", and reading it as a refusal dropped the message
 *     during exactly the burst that produced it.
 *   - `RETRYABLE_RELAY_STATUS` (502) — Telegram 5xx, a network failure
 *     reaching api.telegram.org, anything else thrown on the way.
 *   - `DEV_RECIPIENT_MISSING_STATUS` (424) — the dev fallback with no
 *     `BOT_DEV_ID`. A deployment fact, not a Telegram failure, which the panel
 *     completes quietly like a dev route's recipient refusal.
 *
 * And every one of those failures gives the event's idempotency claim back
 * (`release`), so the panel's retry of the event really sends — at least once,
 * and `release` says why a failure that may have left a message behind is no
 * exception.
 */
const TELEGRAM_REFUSED_STATUS = 422;
const RETRY_LATER_STATUS = 503;
const DEV_RECIPIENT_MISSING_STATUS = 424;

/**
 * `Retry-After` for a replay that finds the first send still out.
 *
 * The panel's relay queue schedules by it: the next attempt waits for the later
 * of its own backoff (15s -> 30s -> 60s) and this wait plus a second
 * (`resolveRelayBackoff`). Only a retry can find the send in flight — the first
 * attempt is the one that claimed it — and by then the queue's own backoff is
 * 30s or more, so 15s says "later" without moving that schedule either way.
 * Broadcast delivery does not read it and re-runs its batch on its own backoff.
 */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 15;

/** What a Bot API call that threw means for the relay that made it. */
type TelegramSendFailure =
  /** Telegram answered and refused THIS message. */
  | { readonly kind: 'refused'; readonly code: number; readonly description: string }
  /** Telegram's 429 flood-wait. */
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number | null }
  /** Anything else: a Telegram 5xx, a transport failure, a non-grammY error. */
  | { readonly kind: 'failed' };

function classifyTelegramFailure(err: unknown): TelegramSendFailure {
  // `HttpError` (api.telegram.org unreachable, a reset socket, grammY's
  // deadline) or anything else thrown on the way: nothing says Telegram refused
  // THIS message.
  if (!(err instanceof GrammyError)) return { kind: 'failed' };
  const retryAfter = err.parameters?.retry_after;
  if (err.error_code === 429 || typeof retryAfter === 'number') {
    return {
      kind: 'rate-limited',
      retryAfterSeconds:
        typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? Math.max(0, Math.ceil(retryAfter)) : null,
    };
  }
  if (err.error_code >= 400 && err.error_code < 500) {
    // Typed as a string, but it is whatever the Bot API (or a local Bot API
    // server) put in the body; a missing one must not crash the answer.
    const description = typeof err.description === 'string' ? err.description : '';
    return { kind: 'refused', code: err.error_code, description };
  }
  // A 5xx: Telegram failing on its own side.
  return { kind: 'failed' };
}

/**
 * Log and answer one failed send. The caller has already released its claim
 * and handled any route-specific outcome (`/notify`'s per-recipient ones).
 */
function answerTelegramFailure(opts: {
  readonly logger: ReturnType<typeof createLogger>;
  readonly res: http.ServerResponse;
  readonly err: unknown;
  /** Log prefix, e.g. `Broadcast`. */
  readonly route: string;
  readonly context: Record<string, unknown>;
}): void {
  const { logger, res, err, route, context } = opts;
  const failure = classifyTelegramFailure(err);
  switch (failure.kind) {
    case 'refused':
      logger.warn(
        { ...context, code: failure.code, description: failure.description },
        `${route}: Telegram refused the message (permanent) — check the chat id, topic, bot membership or the text`,
      );
      res.statusCode = TELEGRAM_REFUSED_STATUS;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: failure.description.length > 0 ? failure.description : 'Telegram refused the message',
          code: failure.code,
        }),
      );
      return;
    case 'rate-limited':
      logger.warn(
        { ...context, retryAfterSeconds: failure.retryAfterSeconds },
        `${route}: Telegram flood-wait — asking for a retry`,
      );
      res.statusCode = RETRY_LATER_STATUS;
      if (failure.retryAfterSeconds !== null) res.setHeader('Retry-After', String(failure.retryAfterSeconds));
      res.end();
      return;
    case 'failed':
      logger.error(
        { ...context, err: loggableTelegramError(err) },
        `${route}: send failed — asking for a retry; a second copy is possible if Telegram had already taken this one`,
      );
      res.statusCode = RETRYABLE_RELAY_STATUS;
      res.end();
      return;
  }
}

/** Answer a replay of a claimed event with what is actually known about it. */
function answerReplay(res: http.ServerResponse, replay: ReplayState): void {
  if (replay.kind === 'in-flight') {
    res.statusCode = RETRY_LATER_STATUS;
    res.setHeader('Retry-After', String(IN_FLIGHT_RETRY_AFTER_SECONDS));
    res.end();
    return;
  }
  if (replay.messageId !== undefined) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messageId: replay.messageId }));
    return;
  }
  res.statusCode = 204;
  res.end();
}

/** The dev fallback has nobody to deliver to. Deliberately not a 204. */
function answerDevRecipientMissing(res: http.ServerResponse): void {
  res.statusCode = DEV_RECIPIENT_MISSING_STATUS;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'BOT_DEV_ID is not configured on the bot: the dev fallback has no recipient' }));
}

/**
 * Telegram's words for "this private chat does not exist for the bot": the
 * subscriber never started it (typical for imported users) or the id names
 * nobody. Read on `/notify` only — on a channel or the dev chat the same words
 * mean the operator's configuration is wrong, which must be loud.
 */
const UNREACHABLE_RECIPIENT_RE = /\b(?:chat not found|user not found|PEER_ID_INVALID)\b/i;

function isUnreachableRecipient(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    typeof err.description === 'string' &&
    UNREACHABLE_RECIPIENT_RE.test(err.description)
  );
}

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
 * Render a notification/broadcast BODY — or a document's caption — with the
 * operator emoji registry so premium/custom emoji tokens (`{{KEY}}`, `:slug:`)
 * render as real Telegram custom emoji, in the form the parse mode carries.
 * Previously the registry was applied only to button labels, so tokens in the
 * body leaked as literal text (e.g. `:translucentpack_9:`) or degraded to
 * plain unicode.
 *
 * The parse mode is never dropped: it is the operator's formatting.
 *  - `HTML` → `<tg-emoji>` tags (`htmlCopy`).
 *  - `MarkdownV2` → its own syntax, `![🔥](tg://emoji?id=…)` (`markdownV2Copy`).
 *    It used to get custom-emoji ENTITIES, which cannot travel with a parse
 *    mode, so the mode was dropped whenever a premium emoji appeared and the
 *    reader got the markup raw — `*bold*`, and every `\.` escape.
 *  - legacy `Markdown` → glyphs; it has no custom-emoji syntax (`markdownCopy`).
 *  - none → `custom_emoji` entities (`messageCopy`).
 */
function renderNotifyBody(
  text: string,
  parseMode: 'HTML' | 'Markdown' | 'MarkdownV2' | undefined,
  emojiCtx: NotifyEmojiContext | undefined,
): { text: string; parseMode: 'HTML' | 'Markdown' | 'MarkdownV2' | undefined; entities: TgCustomEmojiEntity[] | undefined } {
  if (emojiCtx === undefined) {
    return { text, parseMode, entities: undefined };
  }
  const emojis = {
    botEmojis: emojiCtx.botEmojis,
    customEmojis: emojiCtx.customEmojis,
    botEmojiOwnerHasPremium: emojiCtx.ownerHasPremium ?? true,
  };
  switch (parseMode) {
    case 'HTML':
      return { text: htmlCopy(text, emojis), parseMode, entities: undefined };
    case 'MarkdownV2':
      return { text: markdownV2Copy(text, emojis), parseMode, entities: undefined };
    case 'Markdown':
      return { text: markdownCopy(text, emojis), parseMode, entities: undefined };
    default: {
      const rendered = messageCopy(text, emojis);
      return {
        text: rendered.text,
        parseMode: undefined,
        entities: rendered.entities.length > 0 ? rendered.entities : undefined,
      };
    }
  }
}

/**
 * A document relay's caption options, the operator's emoji tokens resolved
 * (`renderNotifyBody`). Without a caption, only the parse mode, as before.
 */
async function renderCaption(
  caption: string | undefined,
  parseMode: 'HTML' | 'MarkdownV2' | undefined,
  cache: BotConfigCache | null | undefined,
): Promise<{
  caption?: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  caption_entities?: TgCustomEmojiEntity[];
}> {
  if (caption === undefined) return parseMode !== undefined ? { parse_mode: parseMode } : {};
  const rendered = renderNotifyBody(caption, parseMode, await resolveEmojiContext(cache));
  return {
    caption: rendered.text,
    ...(rendered.parseMode !== undefined ? { parse_mode: rendered.parseMode } : {}),
    ...(rendered.entities !== undefined ? { caption_entities: rendered.entities } : {}),
  };
}

/**
 * Returns the bound `http.Server`, or `null` when the listener is disabled
 * (no shared secret). Callers in production ignore it; tests need it to learn
 * the ephemeral port (`port: 0`) and to close the socket afterwards.
 */
export function startInternalHttpListener(opts: ListenerOptions): http.Server | null {
  const { bot, cache, secret, port, logger, onUserBlocked, devId, rezeisAdminUrl, keyboardUrls, onConfigApplied } = opts;
  if (secret === null || secret.length === 0) {
    logger.info(
      'Internal HTTP listener disabled (REZEIS_INTERNAL_SHARED_SECRET unset)',
    );
    return null;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const url = req.url ?? '';

    // Read the body up front (capped) so the HMAC can be verified over it
    // before we dispatch. The cap must cover the largest endpoint: the document
    // relays (`/notify-*-document`) carry a full `.txt` report as `content`,
    // which reiwa admits up to ~1 MB — a 16 KiB cap here silently 413'd big
    // error reports (relayed as a permanent drop). 2 MiB leaves headroom for
    // JSON overhead on top of the 1 MB payload.
    let raw: string;
    try {
      raw = await readBody(req, 2 * 1024 * 1024);
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
        await handleInvalidate(cache, logger, res, onConfigApplied);
        return;
      }
      if (url === '/invalidate-policy') {
        handleInvalidatePolicy(logger, res);
        return;
      }
      if (url === '/notify') {
        await handleNotify({ bot, logger, raw, res, onUserBlocked, keyboardUrls, rezeisAdminUrl: rezeisAdminUrl ?? null, cache });
        return;
      }
      if (url === '/notify-dev') {
        await handleNotifyDev({ bot, devId, logger, raw, res, cache });
        return;
      }
      if (url === '/notify-dev-document') {
        await handleNotifyDevDocument({ bot, devId, logger, raw, res, cache });
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
      if (url === '/notify-broadcast-document') {
        await handleNotifyBroadcastDocument({ bot, logger, raw, res, cache });
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (err: unknown) {
      logger.error({ err: loggableTelegramError(err), path: url }, 'Internal listener handler crashed');
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
  return server;
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
  // Legacy fallback: shared secret in the X-Auth-Token header. Constant-time
  // compare so the transitional token path can't be brute-forced via a timing
  // side-channel on the `===` string comparison.
  const token = req.headers['x-auth-token'];
  return typeof token === 'string' && timingSafeStringEqual(token, secret);
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
  onConfigApplied?: (config: BotConfig) => void | Promise<void>,
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
    // After the ack, never before. See `onConfigApplied` on ListenerOptions.
    if (fresh !== null && onConfigApplied !== undefined) {
      void (async () => {
        try {
          await onConfigApplied(fresh);
        } catch (err: unknown) {
          // Bot API pushes (commands, profile): the same errors as a failed send.
          logger.warn({ err: loggableTelegramError(err) }, 'Cache-invalidate: post-refresh apply failed');
        }
      })();
    }
  } catch (err: unknown) {
    logger.error({ err }, 'Cache-invalidate: forceInvalidate threw');
    res.statusCode = 500;
    res.end();
  }
}

/**
 * `/invalidate-policy` — drop THIS process's platform-policy and legal-documents
 * caches, so the next `/start`, menu or rules screen reads the operator's change
 * instead of waiting out the 60s TTL.
 *
 * Unlike `/invalidate` this never answers 503: it needs neither the bot nor the
 * bot-config cache, and a cache no page has built yet holds nothing stale. Both
 * calls leave a missing cache missing, which is what makes that safe — this
 * route has no admin client to build one with, and a cache built without one
 * would serve its fallback for the life of the process.
 */
function handleInvalidatePolicy(
  logger: ReturnType<typeof createLogger>,
  res: http.ServerResponse,
): void {
  invalidatePolicyCache();
  invalidateLegalDocumentsCache();
  res.statusCode = 204;
  res.end();
  logger.info('Policy-invalidate: dropped the policy and legal-documents caches');
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
  /**
   * For the operator's emoji tokens in the card. The panel builds these cards
   * itself and does not resolve pack emoji in them (only its broadcasts and
   * user notifications go through its `CustomEmojiService`), so a `:slug:` in
   * a plan's or a user's name reached the operator as the token.
   */
  readonly cache?: BotConfigCache | null;
}

/**
 * `/notify-dev` — deliver a system-event card to the bot's developer/operator
 * (`BOT_DEV_ID`). Used by rezeis as the automatic fallback when no operator
 * group/topic is configured: the message lands in the dev's private DM with
 * this same bot, so it's visible only to them.
 *
 * NEVER a 204 for a card that did not arrive. This route used to "soft-succeed"
 * on everything — no `BOT_DEV_ID`, Telegram refusing, Telegram down — on the
 * theory that the firehose is best-effort. The panel does not read a 204 as
 * "best-effort, maybe": it reads it as a delivered card, so the one channel an
 * operator with nothing configured has went silent while the panel recorded
 * every card as sent. Now: no bot 503, no `BOT_DEV_ID` 424, and a failed send
 * answers what the failure was (`answerTelegramFailure`).
 */
async function handleNotifyDev(opts: DevNotifyHandlerOptions): Promise<void> {
  const { bot, devId, logger, raw, res } = opts;
  if (bot === null) {
    res.statusCode = 503;
    res.end();
    return;
  }
  if (devId === undefined) {
    answerDevRecipientMissing(res);
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
  // Replay guard. rezeis relays this event off a BullMQ queue with 4 attempts
  // (15s -> 30s -> 60s), so the same card can arrive up to four times; without
  // this the operator gets four identical cards for one incident. Claimed AFTER
  // the payload checks above so a 400 never burns the id, and BEFORE the send so
  // two overlapping retries cannot both get through.
  const claim = claimDevEvent('notify-dev', payload.eventId);
  if (claim.kind === 'replay') {
    answerReplay(res, claim.replay);
    return;
  }
  const claimKey = claim.kind === 'claimed' ? claim.key : null;
  const parseMode = isValidParseMode(payload.parseMode) ? payload.parseMode : undefined;
  // The operator's emoji tokens, in the form the parse mode carries.
  const card = renderNotifyBody(text, parseMode, await resolveEmojiContext(opts.cache));
  // Universal "Close" button so the dev can dismiss a handled event card
  // (routed by the shared `close` callback → deletes the message).
  const keyboard = new InlineKeyboard().text('❌ Закрыть', 'close');
  try {
    await bot.api.sendMessage(devId, card.text, {
      ...(card.parseMode !== undefined ? { parse_mode: card.parseMode } : {}),
      ...(card.entities !== undefined ? { entities: card.entities } : {}),
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    if (claimKey !== null) IDEMPOTENCY_CACHE.settle(claimKey);
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    if (claimKey !== null) IDEMPOTENCY_CACHE.release(claimKey);
    answerTelegramFailure({ logger, res, err, route: 'Notify-dev', context: { devId } });
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
 * group's error report and matches the agreed card layout. Answers exactly as
 * `/notify-dev` does when there is no bot, no `BOT_DEV_ID`, or the send fails.
 */
async function handleNotifyDevDocument(opts: DevNotifyHandlerOptions): Promise<void> {
  const { bot, devId, logger, raw, res } = opts;
  if (bot === null) {
    res.statusCode = 503;
    res.end();
    return;
  }
  if (devId === undefined) {
    answerDevRecipientMissing(res);
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
  // Replay guard — see `/notify-dev` above. Same queue, same 4 attempts, and a
  // duplicate here costs the operator a whole second copy of the error report.
  const claim = claimDevEvent('notify-dev-document', payload.eventId);
  if (claim.kind === 'replay') {
    answerReplay(res, claim.replay);
    return;
  }
  const claimKey = claim.kind === 'claimed' ? claim.key : null;
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
      ...(await renderCaption(caption, parseMode, opts.cache)),
      reply_markup: keyboard,
    });
    if (claimKey !== null) IDEMPOTENCY_CACHE.settle(claimKey);
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    if (claimKey !== null) IDEMPOTENCY_CACHE.release(claimKey);
    answerTelegramFailure({ logger, res, err, route: 'Notify-dev-document', context: { devId } });
  }
}

/**
 * `/notify-broadcast-document` — deliver an error-report document to the
 * configured operator chat/topic while preserving the sectioned card as its
 * caption. This is the split-deployment counterpart of `/notify-dev-document`.
 */
async function handleNotifyBroadcastDocument(opts: {
  readonly bot: Bot<Context> | null;
  readonly logger: ReturnType<typeof createLogger>;
  readonly raw: string;
  readonly res: http.ServerResponse;
  /** For the operator's emoji tokens in the caption — see `DevNotifyHandlerOptions.cache`. */
  readonly cache?: BotConfigCache | null;
}): Promise<void> {
  const { bot, logger, raw, res } = opts;
  if (bot === null) {
    res.statusCode = 503;
    res.end();
    return;
  }
  let payload: BroadcastDocumentPayload;
  try {
    payload = JSON.parse(raw) as BroadcastDocumentPayload;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : null;
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : null;
  const content = typeof payload.content === 'string' ? payload.content : null;
  if (eventId === null || chatId === null || content === null || content.length === 0) {
    res.statusCode = 400;
    res.end();
    return;
  }
  if (!IDEMPOTENCY_CACHE.claim(eventId)) {
    answerReplay(res, IDEMPOTENCY_CACHE.replayOf(eventId));
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
  const topicThreadId =
    typeof payload.topicThreadId === 'number' && Number.isInteger(payload.topicThreadId)
      ? payload.topicThreadId
      : undefined;
  const keyboard = new InlineKeyboard().text('❌ Закрыть', 'close');
  try {
    const document = new InputFile(Buffer.from(content, 'utf8'), filename);
    await bot.api.sendDocument(chatId, document, {
      ...(await renderCaption(caption, parseMode, opts.cache)),
      ...(topicThreadId !== undefined ? { message_thread_id: topicThreadId } : {}),
      reply_markup: keyboard,
    });
    IDEMPOTENCY_CACHE.settle(eventId);
    res.statusCode = 204;
    res.end();
  } catch (err: unknown) {
    // A refused report used to answer 204 here — a delivered report, upstream —
    // and a failed one kept its claim, so the panel's retry was answered as a
    // replay without sending. Same rules as `/notify-broadcast` now.
    IDEMPOTENCY_CACHE.release(eventId);
    answerTelegramFailure({ logger, res, err, route: 'Broadcast document', context: { eventId, chatId } });
  }
}

/**
 * The status `/notify-backup-document` answers when it wants rezeis to try the
 * whole relay again.
 *
 * It is 502 rather than any other 5xx because of what happens to it on the way
 * back: reiwa-api's webhook router turns a bot 5xx into its own 502
 * (`webhooks.ts`, `BotRelayError`), rezeis's `BotNotifierClient` files a non-2xx
 * as `rejected` carrying that status, and `isRetryableRelayOutcome` then asks
 * `isTransientHttpStatus` about it. 502 is the value that survives all three
 * hops meaning "temporary — ask again", and it is what the sibling
 * `handleNotifyBroadcastDocument` already answers for the same class of event.
 */
const RETRYABLE_RELAY_STATUS = 502;

/**
 * Whether a status rezeis returned for the backup DOWNLOAD means "ask again".
 *
 * Deliberately identical to rezeis's own `isTransientHttpStatus` in
 * `src/modules/backup/backup-delivery-retry.util.ts` — `status >= 500 ||
 * status === 408 || status === 429` — because that function is what decides, on
 * the far side of the hop, whether the answer we give here actually buys a
 * retry. They are two copies of one rule and CAN drift: nothing at build time
 * links these repos, which ship as separate images.
 *
 * Three things bound that risk, and they are why this is a copy rather than an
 * invented second list:
 *
 *  - The only value that crosses the hop is `RETRYABLE_RELAY_STATUS` itself, so
 *    the sole way drift can break the feature is rezeis dropping 5xx from its
 *    transient set — which would equally break `handleNotifyBroadcastDocument`
 *    and reiwa-api's 502, i.e. it is not a quiet failure of this branch alone.
 *  - `test/bot/internal-backup-relay.test.ts` pins this set code-by-code, so
 *    changing it here is a deliberate act that turns a test red rather than a
 *    silent edit.
 *  - That test also closes the loop: it asserts this predicate calls
 *    `RETRYABLE_RELAY_STATUS` transient. Narrow the rule and the status we
 *    answer stops meaning what we answer it for, and the suite says so.
 */
function isTransientDownloadStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** Exported for the relay tests, which pin the set above against rezeis's copy. */
export const BACKUP_RELAY_CONTRACT = {
  retryableStatus: RETRYABLE_RELAY_STATUS,
  isTransientDownloadStatus,
} as const;

/**
 * `/notify-backup-document` — fetch a backup file from rezeis (signed download
 * URL) and upload it to the configured Telegram chat/topic. Used on the split
 * deployment where rezeis has no bot token: rezeis hands the bot a short-lived
 * token, the bot pulls the bytes over the docker hop and re-uploads them.
 * Best-effort.
 *
 * Answers `200 { messageId }` when — and only when — Telegram returned a
 * message id for the upload. Every other outcome answers `204` (rezeis:
 * `unconfirmed`, deliberately never retried) EXCEPT the two download failures
 * that are both momentary and provably pre-upload, which answer
 * `RETRYABLE_RELAY_STATUS` so rezeis tries again. The dividing line is not
 * "did it fail" but "could a retry put a second multi-gigabyte file in the
 * operator's topic": once `sendDocument` has been entered it could, so
 * everything from there on stays on 204.
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
  // The download gets its own `try` — it used to share one with the upload
  // below, which collapsed three different events into a single 204. Everything
  // that fails in here fails BEFORE a byte reaches Telegram, so a retry cannot
  // duplicate anything; everything that fails after `sendDocument` is entered
  // may already have delivered the file, and must not ask for one.
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(downloadUrl);
  } catch (err: unknown) {
    // `fetch` threw, so no HTTP exchange completed at all: DNS, refused
    // connection, TLS, a socket reset on the docker hop. Nothing was uploaded
    // and the cause is almost always momentary — rezeis mid-restart is the
    // common one — which makes this the cheapest retry of the set, exactly the
    // reading rezeis gives its own `failed` status for the mirror-image hop.
    // A permanently wrong `REZEIS_ADMIN_URL` lands here too and will spend all
    // three attempts; that cost is bounded, and a misconfigured backup relay is
    // the failure an operator most needs to hear about loudly.
    logger.warn(
      { err, recordId },
      'Notify-backup-document: download never reached rezeis — asking for a retry',
    );
    res.statusCode = RETRYABLE_RELAY_STATUS;
    res.end();
    return;
  }
  if (!response.ok) {
    // rezeis answered, and its status says whether asking again can change the
    // answer. 5xx/408/429 is rezeis having a bad moment (restarting, overloaded,
    // shedding load) → retry. Any other status is rezeis refusing THIS request —
    // a spent or forged download token, a record that no longer exists — and it
    // will refuse an identical retry identically, so three attempts buy nothing
    // but a delay on telling the operator. 204 → rezeis reads `unconfirmed`.
    const retryable = isTransientDownloadStatus(response.status);
    logger.warn(
      { status: response.status, recordId, retryable },
      'Notify-backup-document: rezeis refused the backup download',
    );
    res.statusCode = retryable ? RETRYABLE_RELAY_STATUS : 204;
    res.end();
    return;
  }
  if (response.body === null) {
    // 2xx with no stream. Per the fetch spec a null body on a successful
    // response means rezeis answered 204/205: it considers the request fine and
    // has no bytes for us. Nothing was uploaded — but unlike the 5xx above this
    // is SYSTEMATIC rather than a bad moment, and an identical retry earns an
    // identically empty response. A retry is only worth its cost when it might
    // change the answer, and here it cannot. 204.
    logger.warn(
      { status: response.status, recordId },
      'Notify-backup-document: rezeis returned no file body',
    );
    res.statusCode = 204;
    res.end();
    return;
  }
  try {
    // Stream the file straight through to Telegram instead of buffering — a
    // 2 GB backup (Local Bot API Server) must never be held in memory.
    const stream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    const document = new InputFile(stream, filename);
    const sent = await bot.api.sendDocument(chatId, document, {
      ...(caption !== undefined ? { caption } : {}),
      ...(topicThreadId !== undefined ? { message_thread_id: topicThreadId } : {}),
    });
    // Echo Telegram's own message id, exactly as `/notify` does below. It is
    // the only evidence in this exchange that the bytes reached Telegram: a 2xx
    // alone proves only that the relay instruction was accepted, since the
    // fetch + upload happen after it. rezeis stamps a backup as delivered
    // off-site ONLY on a numeric id, so a bare 204 here records every single
    // backup as undelivered — forever, on every cycle.
    const messageId = typeof sent.message_id === 'number' ? sent.message_id : null;
    if (messageId === null) {
      // Upload resolved but Telegram named no id. Never invent one, and never
      // ask for a retry: the file is already up there, so a second attempt
      // would put a second copy in the topic without changing the answer.
      // 204 → rezeis reads `unconfirmed`, which it deliberately does not retry.
      logger.warn({ recordId, chatId }, 'Notify-backup-document: sent without a message id');
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ messageId }));
  } catch (err: unknown) {
    logger.warn({ err: loggableTelegramError(err), recordId }, 'Notify-backup-document: send failed');
    // POST-UPLOAD. `sendDocument` has been entered, so the bytes may already be
    // in the operator's topic even though the call rejected — a mid-upload
    // socket reset on a multi-gigabyte file surfaces right here, and so does a
    // response that was lost after Telegram accepted the file. This branch must
    // therefore stay on 204 (rezeis: `unconfirmed`, never retried) no matter how
    // transient the error text looks: a missing off-site copy is alerted and
    // visible, a silent second 2 GB upload is neither.
    res.statusCode = 204;
    res.end();
  }
}

/**
 * How long `/notify` holds its 204 for a blocked subscriber while
 * `onUserBlocked` records the block.
 *
 * Awaited, because the panel reads the record back right after the answer:
 * broadcast delivery sleeps 50ms after `notifyUser` returns and then re-reads
 * `isBotBlocked`, and that one read decides whether the row is "blocked by the
 * user" or an error the operator is offered to retry (rezeis-admin,
 * `broadcast-delivery.service.ts`). The block travels bot -> panel HTTP ->
 * Prisma, so answering first lost that race whenever the round trip took
 * longer than those 50ms.
 *
 * Capped, because the record is a call to the panel, whose transport waits up
 * to 10s for headers — and reiwa-api gives this whole hop 8s
 * (`BOT_RELAY_TIMEOUT_MS`). Waited for without a limit, a slow panel turned
 * this final, quiet answer into reiwa-api's 502, which the panel retries —
 * every retry another send to the subscriber who blocked the bot — alerts on
 * once the attempts are spent, and counts toward broadcast delivery's relay
 * circuit breaker. Two seconds leaves the hop six to spare; a panel slower than
 * that gets its row filed as an error, and the block still lands.
 */
const USER_BLOCKED_REPORT_WAIT_MS = 2_000;

/**
 * Run `onUserBlocked` and wait for it, at most `USER_BLOCKED_REPORT_WAIT_MS`.
 * Past the cap the call carries on in the background. Never throws: a failure,
 * awaited or not, is logged.
 */
async function reportUserBlocked(
  onUserBlocked: ((telegramId: string) => Promise<void> | void) | undefined,
  telegramId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  if (onUserBlocked === undefined) return;
  const report = (async (): Promise<'recorded'> => {
    try {
      await onUserBlocked(telegramId);
    } catch (blockErr: unknown) {
      logger.warn({ err: blockErr, telegramId }, 'Notify: onUserBlocked callback threw');
    }
    return 'recorded';
  })();
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<'capped'>((resolve) => {
    timer = setTimeout(() => resolve('capped'), USER_BLOCKED_REPORT_WAIT_MS);
  });
  try {
    if ((await Promise.race([report, cap])) === 'capped') {
      logger.warn(
        { telegramId, waitedMs: USER_BLOCKED_REPORT_WAIT_MS },
        'Notify: recording the block is taking too long — answering now, it finishes in the background',
      );
    }
  } finally {
    clearTimeout(timer);
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
    // Replay. Delivered: answer with the message id we kept, because the
    // caller's bar for a user notification is proof — a bodiless 204 here was
    // read as "not delivered" and wrote the recipient down as failed, even
    // though they had the message in hand. Still in flight: 503, so the retry
    // comes back for the real outcome instead of settling on a guess.
    answerReplay(res, IDEMPOTENCY_CACHE.replayOf(eventId));
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
    // from rezeis by the resolver, which answers `null` rather than throw when
    // that download fails. Any photo failure falls back to text so a banner
    // glitch never drops the notification.
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
            { err: loggableTelegramError(photoErr), telegramId },
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
    // Kept, so a replay of this same event can answer with the id instead of a
    // bodiless ack the caller reads as "not delivered".
    IDEMPOTENCY_CACHE.settle(eventId, sent.message_id);

    // Return the Telegram message id so admin can persist it and later
    // edit/delete the message within Telegram's 48h edit window.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ messageId: sent.message_id }));
  } catch (err: unknown) {
    // The claim is given back on every failure (see `release`). It used to be
    // held here: a 502 asked the panel to retry, and the retry found the id
    // taken and answered 204 — `unconfirmed`, i.e. the silent, un-alerted
    // "blocked the bot" outcome — without sending.
    IDEMPOTENCY_CACHE.release(eventId);
    if (err instanceof GrammyError && err.error_code === 403) {
      // User has blocked the bot or removed it from chat. Per-recipient and
      // final. The panel's contract for exactly this: a 2xx without a message
      // id on a user notification is undelivered, never retried, and never
      // alerted (`shouldAlertOperator`). The host records the block first, so
      // the panel stops trying — and so broadcast delivery can tell this row
      // from an error when it reads the flag back (`USER_BLOCKED_REPORT_WAIT_MS`).
      logger.info({ telegramId, eventId }, 'Notify: user blocked the bot');
      await reportUserBlocked(onUserBlocked, telegramId, logger);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (isUnreachableRecipient(err)) {
      // The same kind of fact about one subscriber — they never started this
      // bot — so the same quiet, final answer. A 422 would raise one operator
      // alert per notification per such subscriber, which on an imported base
      // is a flood nobody can act on. Not a block, so no `onUserBlocked`.
      logger.info({ telegramId, eventId }, 'Notify: recipient has no chat with the bot');
      res.statusCode = 204;
      res.end();
      return;
    }
    // Anything else is about the message or the link, not the person: a text
    // Telegram will not take is 422 and alerted, a flood-wait or an outage is
    // retried.
    answerTelegramFailure({ logger, res, err, route: 'Notify', context: { eventId, telegramId } });
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
    answerReplay(res, IDEMPOTENCY_CACHE.replayOf(eventId));
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
    const sent = await bot.api.sendMessage(chatId, body.text, {
      parse_mode: body.parseMode,
      entities: body.entities,
      reply_markup,
      message_thread_id: messageThreadId,
    });
    // ECHO TELEGRAM'S OWN MESSAGE ID, as `handleNotify` already does. A bodiless
    // 204 is classified by the panel as `unconfirmed` — "the instruction was
    // accepted, nothing is claimed about what happened to it" — and the relay
    // policy then treated that as delivered. The id is the only evidence in
    // this exchange that anything reached Telegram, and without it a channel
    // post could never be told apart from one that silently went nowhere.
    IDEMPOTENCY_CACHE.settle(eventId, sent.message_id);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messageId: sent.message_id }));
  } catch (err: unknown) {
    // Permanent client errors (chat not found / bot not in chat / bad topic
    // id) won't be fixed by a retry — they mean the operator's Chat ID / topic
    // is wrong.
    //
    // ANSWER 422, NOT 204. The original reasoning — "ack so the admin side
    // doesn't escalate to a 502 cascade" — was right about not retrying and
    // wrong about how to say it: a 204 means `unconfirmed` upstream, which the
    // relay policy reads as DELIVERED. So a channel the bot is not an admin of
    // produced a warning in this container's log and a green "posted" in the
    // panel. A 4xx is classified `rejected` — terminal, NOT delivered, and it
    // raises the operator alert that names the chat id. No retry either way.
    //
    // EXCEPT 429, which answered 422 here too and so dropped the post for good
    // during the very burst that produced it: it is a wait, not a refusal, and
    // `classifyTelegramFailure` reads it first. Every failure gives the claim
    // back — held, it answers the next attempt without sending anything, and
    // the panel records that answer as a posted card (see `release`).
    IDEMPOTENCY_CACHE.release(eventId);
    answerTelegramFailure({ logger, res, err, route: 'Broadcast', context: { eventId, chatId } });
  }
}

