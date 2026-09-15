import { Router, type Response } from "express";
import { Api } from "grammy";

import type { LoggerPort } from "../../application/ports/logger.port.js";
import {
  LOG_INTERVAL_MS,
  resolveChannelGateVerdict,
  resolveChannelJoinUrl,
  type ChannelGateStore,
  type ChannelGateVerdict,
  type ChatMemberApi,
} from "../../bot/lib/channel-gate.js";
import type { ReiwaConfig } from "../../config.js";
import { getPolicyCache, type CachedPolicy } from "../../infrastructure/admin-client/policy-cache.js";
import { RedisChannelGateStore } from "../../infrastructure/channel-gate/redis-channel-gate-store.js";
import { TtlMap } from "../../infrastructure/channel-gate/ttl-map.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { invalidateStaleUserSession } from "../lib/stale-user-session.js";
import { createTelegramUserIdCache, parseTelegramUserId } from "../lib/telegram-user-id.js";
import { describeUpstreamError } from "../lib/upstream-error.js";
import { getRequestLogger, type LoggerLike } from "../middleware/logger-accessor.js";
import { createAccountRateLimiter } from "../middleware/rate-limit.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";

/**
 * «Канал обязателен» for the Telegram Mini App.
 *
 * The owner's rule (14.09.2026): inside the Mini App the whole cabinet is
 * replaced by a "subscribe to the channel" screen until Telegram confirms the
 * membership, and everybody is checked the same way — paying subscribers
 * included. The cabinet opened in an ordinary browser is NOT gated, so no other
 * route refuses anything on the gate's behalf: blocking them server-side would
 * block the browser cabinet too. The SPA asks here only when it runs as a Mini
 * App, and draws the screen itself.
 *
 * ── CONTRACT ──────────────────────────────────────────────────────────────
 *
 *   GET  /api/v1/channel-gate
 *   POST /api/v1/channel-gate/check        body: {} (ignored)
 *
 *   200 { "status": "off" | "subscribed" | "not-subscribed" | "unverified",
 *         "joinUrl": string | null }
 *       `Cache-Control: no-store` — the answer is about one person, right now.
 *
 *   GET is the ordinary check and may answer from the gate's memory (below).
 *   POST is a fresh one — «✅ Я подписался» and the re-check on returning to the
 *   foreground — and skips the remembered "not subscribed" (and, while
 *   «Перепроверять подписку» is ON, the remembered pass): somebody who has just
 *   joined must not be refused on a memo.
 *
 *   status
 *     off             nothing to enforce: «Канал обязателен» is off; the policy
 *                     could not be read, or what came back is not a policy (said
 *                     at most once per 10 minutes — the gate fails open, never
 *                     closed); or the account has no Telegram id (registered on
 *                     the web, never linked — there is nobody to ask about).
 *     subscribed      Telegram says the user is in the channel (or said so
 *                     recently enough to be trusted — below).
 *     not-subscribed  Telegram says they are not: show the join screen.
 *     unverified      the gate is on but this user could not be checked — no
 *                     BOT_TOKEN here (said once), the panel could not say which
 *                     Telegram user the account is (said at most once per 10
 *                     minutes, never remembered), the policy names no chat the
 *                     Bot API can resolve, the bot is not an administrator of the
 *                     channel, Telegram cannot look the user up, Telegram asked to
 *                     slow down or cannot be reached. LET THEM IN. What the
 *                     operator must fix is reported to the panel's Events page by
 *                     the gate module, filed under the API.
 *   joinUrl           the channel's public link for the join button (a `tg:`
 *                     link arrives as its `https://t.me` twin); `null` when status
 *                     is "off", or when no link or username is configured.
 *
 *   401 { "message": "Unauthorized" }   no session — the WebSession or the
 *       legacy Telegram session, the same acceptance as every identity-agnostic
 *       route (`createFlexibleSessionMiddleware`). Also when the panel answers
 *       that the account is blocked (403 `USER_BLOCKED`) or no longer exists
 *       (404 `User not found`): the session is ended first, as `/session` and
 *       `/me` do (`lib/stale-user-session.ts`). Those two answers only — any
 *       other refusal from the panel (a token reiwa and rezeis disagree on, a
 *       route this panel version lacks, a request it will not read) says nothing
 *       about the account, and is answered "unverified" with the session kept.
 *   429 { "message": "Too many requests, please try again later", "retryAfter": <s> }
 *       + `Retry-After` — more than {@link CHANNEL_GATE_READ_LIMIT} GETs or
 *       {@link CHANNEL_GATE_CHECK_LIMIT} POSTs in a minute for one account (each
 *       route its own budget; every session of one account shares it). Counted
 *       only after the session is known, so a caller without one is answered 401
 *       and spends nobody's budget. A GET opened as a top-level document is
 *       redirected to `/sign-in?rate_limited=1` instead, as by every generic
 *       limiter. (Every /api route also shares the global per-address limiter,
 *       which answers the same shape.)
 *   403 { "message": "Forbidden: origin …" }   POST only, from the app-wide
 *       CSRF check (`middleware/csrf-protection.ts`), which runs first: a POST
 *       carrying a session cookie must present an `Origin` (or `Referer`) equal
 *       to the cabinet's own. The SPA's shared axios client sends a same-origin
 *       XHR, and the Fetch standard attaches the real `Origin` to every non-GET
 *       request made in CORS mode whatever the referrer policy — so it survives
 *       Helmet's `Referrer-Policy: no-referrer`, which does strip the `Referer`.
 *       No token or extra header is involved. A form post or a `no-cors` fetch
 *       would carry `Origin: null` and be refused.
 *
 * ── WHAT THE GATE MODULE REMEMBERS ────────────────────────────────────────
 *
 * The decision is `resolveChannelGateVerdict` (`bot/lib/channel-gate.ts`), the
 * same one the bot asks before every update; its header is the full account.
 * What it means for these two routes:
 *  - «Перепроверять подписку» ON: GET trusts a pass for a minute, in this
 *    process's memory only; POST asks Telegram whatever is remembered; and ANY
 *    "not subscribed" forgets the user's pass, in memory and in the shared store.
 *  - OFF: a pass lives in the shared store for a year, behind ten minutes of
 *    process memory, and BOTH routes honour it — a user who passed once is not
 *    asked again, by GET or by POST, and the pass is never forgotten. The store
 *    is the Redis the bot writes to, so a user the bot let in is let in here and
 *    the other way round. Passes are keyed by the resolved chat (a username
 *    lower-cased) and the Telegram user.
 *  - GET answers a "not subscribed" for ten seconds without asking again; POSTs
 *    of one user within two seconds share one answer; checks that overlap share
 *    one call, but a POST never takes the answer of a call a GET started.
 *  - A refusal Telegram words as about the USER (user or member not found,
 *    PARTICIPANT_ID_INVALID, USER_ID_INVALID, PEER_ID_INVALID…) answers
 *    "unverified" for that user for a minute and alerts nobody. One worded as
 *    about the CHAT (member list is inaccessible, chat not found, the bot is not
 *    an administrator or not a member…) answers "unverified" for everyone in it
 *    for five seconds — a minute when it repeats within two — and alerts the
 *    operator at most once an hour per cause, across the bot and the API. Wording
 *    nobody recognises is the user's until a second user gets it within ten
 *    minutes. A 429 waits out `retry_after`, at most a minute; an unreachable
 *    Telegram, five seconds.
 *  - Store writes and operator alerts run after the answer, never in front of it.
 *
 * ── THE SHARED STORE ──────────────────────────────────────────────────────
 *
 * `RedisChannelGateStore` on the WebSession store's client when `REDIS_URL` is
 * set: no connection of its own, and no listener on one it does not own. That
 * client's connection errors are the session store's to log, and it does; the
 * gate's store speaks only of what it met itself — a command that failed, a
 * client not ready when it had one to send — at most once per 10 minutes each.
 * While the client is not `ready`, and for ten seconds after a command failed,
 * the store answers from this process's memory without sending anything, so a
 * Redis outage never holds an answer. Without `REDIS_URL`: this process's
 * memory, said once at start.
 *
 * ── WHERE THE TELEGRAM ID COMES FROM ──────────────────────────────────────
 *
 * A WebSession names only the account, so its Telegram id is read from the
 * panel — the payload `/session` serves — and remembered for five minutes
 * (`lib/telegram-user-id.ts`). The legacy session carries the id itself. When a
 * request has both, the WebSession wins, as it does for every other identity
 * lookup (`resolveUserIdentity`): the legacy cookie may be an older sign-in.
 */

/** What both routes answer. */
export interface ChannelGateAnswer {
  readonly status: ChannelGateVerdict;
  readonly joinUrl: string | null;
}

/**
 * How long this client waits on Telegram for one membership check.
 *
 * grammY's own default is 500 seconds, sized for long polling. The gate module
 * races every call against its own six-second deadline, so the Mini App gets
 * its answer either way — but the request underneath would stay open for eight
 * minutes on a token the bot shares. Five seconds fires first, closes it, and is
 * the request path's other outbound bound (Turnstile, `lib/turnstile.ts`).
 */
export const CHANNEL_GATE_TELEGRAM_TIMEOUT_SECONDS = 5;

/**
 * Fresh checks one account may ask for per window. A person tapping
 * «✅ Я подписался» and switching between the channel and the Mini App stays
 * well inside it; a stuck loop in a client does not.
 */
export const CHANNEL_GATE_CHECK_LIMIT = 10;

/**
 * Ordinary checks one account may ask for per window. The SPA sends one per
 * launch and one per account switch; a loop from rotating addresses — which the
 * global per-address limiter does not see as one caller — stops here instead of
 * on the token the bot shares.
 */
export const CHANNEL_GATE_READ_LIMIT = 30;

/** The window both budgets are counted over. */
export const CHANNEL_GATE_LIMIT_WINDOW_MS = 60_000;

const OFF: ChannelGateAnswer = { status: "off", joinUrl: null };

/**
 * The Telegram client the API asks with — the bot's own token and, when the
 * operator runs a Local Bot API Server, its address too: a bot that has logged
 * out of the cloud API to use a local server cannot be served by the cloud API.
 * `null` without a token.
 */
export function createChatMemberApi(
  config: Pick<ReiwaConfig, "BOT_TOKEN" | "TELEGRAM_BOT_API_ROOT">,
  timeoutSeconds: number = CHANNEL_GATE_TELEGRAM_TIMEOUT_SECONDS,
): ChatMemberApi | null {
  if (!config.BOT_TOKEN) return null;
  return new Api(config.BOT_TOKEN, {
    ...(config.TELEGRAM_BOT_API_ROOT ? { apiRoot: config.TELEGRAM_BOT_API_ROOT } : {}),
    timeoutSeconds,
  });
}

export interface ChannelGateRouterDeps {
  readonly adminClient: AdminClient | null;
  readonly sessionStore: SessionStore | null;
  /** Its Redis client carries the gate's shared store; `null` without `REDIS_URL`. */
  readonly webSessionStore: WebSessionStore | null;
  readonly config: ReiwaConfig;
  /** The process logger: the start-up line and the shared store's own warnings. */
  readonly logger?: LoggerPort;
  /** Who asks Telegram. Built from the config when omitted; a spec passes its own. */
  readonly chatMemberApi?: ChatMemberApi;
}

type TelegramUser =
  | { readonly kind: "id"; readonly id: number }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly error: unknown };

export function createChannelGateRouter(deps: ChannelGateRouterDeps): Router {
  const { adminClient, sessionStore, config } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const readLimiter = createAccountRateLimiter({
    windowMs: CHANNEL_GATE_LIMIT_WINDOW_MS,
    limit: CHANNEL_GATE_READ_LIMIT,
  });
  const checkLimiter = createAccountRateLimiter({
    windowMs: CHANNEL_GATE_LIMIT_WINDOW_MS,
    limit: CHANNEL_GATE_CHECK_LIMIT,
  });
  const telegram = deps.chatMemberApi ?? createChatMemberApi(config);
  // The session store's client, handed over, not owned: the store attaches no
  // listener, and this router adds none either — that client's connection
  // errors are already the session store's to log.
  const store: ChannelGateStore | undefined = deps.webSessionStore
    ? new RedisChannelGateStore({ redis: deps.webSessionStore.getRedis(), logger: deps.logger })
    : undefined;
  if (store === undefined) {
    deps.logger?.warn(
      "Channel gate (Mini App): REDIS_URL is not set — passes of «Перепроверять подписку» OFF and the " +
        "operator-alert throttle live in this process only, so the API and the bot each re-check and alert separately",
    );
  }
  const telegramUserIds = createTelegramUserIdCache({
    lookup: async (userId) => {
      if (adminClient === null) throw new Error("AdminClient not configured");
      const session = (await adminClient.user.getSession({ userId })) as
        | { readonly telegramId?: unknown }
        | null
        | undefined;
      return session?.telegramId ?? null;
    },
  });
  // Per router, which in production is per process: `createApp` builds one. A
  // spec building its own app starts with fresh ones.
  let missingTokenLogged = false;
  const warnedAt = new TtlMap<string>({ maxEntries: 10 });
  const router = Router();

  /** One line per condition per 10 minutes: an outage is one problem, not a line per launch. */
  function warnAtMostEvery(log: LoggerLike, condition: string, context: object, message: string): void {
    if (warnedAt.has(condition)) return;
    warnedAt.set(condition, true, LOG_INTERVAL_MS);
    log.warn(context, message);
  }

  async function telegramUserOf(req: AuthRequest): Promise<TelegramUser> {
    const accountId = req.webSession?.userId;
    if (typeof accountId === "string" && accountId.length > 0) {
      try {
        const id = await telegramUserIds.resolve(accountId);
        return id === null ? { kind: "none" } : { kind: "id", id };
      } catch (error: unknown) {
        return { kind: "unknown", error };
      }
    }
    const id = parseTelegramUserId(req.telegramId);
    return id === null ? { kind: "none" } : { kind: "id", id };
  }

  /** `null`: the panel says the account is blocked or gone, and its session has been ended. */
  async function decide(req: AuthRequest, fresh: boolean): Promise<ChannelGateAnswer | null> {
    const log = getRequestLogger(req);

    let policy: CachedPolicy;
    try {
      policy = await getPolicyCache(adminClient).get();
    } catch (err: unknown) {
      warnAtMostEvery(
        log,
        "policy-unreadable",
        { err },
        "channel-gate: the platform policy could not be read; the gate is off meanwhile",
      );
      return OFF;
    }
    // `PolicyCache` reads a body that is not an object as a failed read and hands
    // out its stand-in (below), so only a cache put in its place gets here.
    // Something that is not an object is no policy: no gate, and no 500 either.
    // The gate module and the bot read it the same way.
    if (typeof policy !== "object" || policy === null) {
      warnAtMostEvery(
        log,
        "policy-unreadable",
        { policy },
        "channel-gate: the policy cache handed out something that is not a policy; the gate is off meanwhile",
      );
      return OFF;
    }
    // The cache hands out a PUBLIC stand-in rather than throwing when the panel
    // does not answer — or answers with something that is not a policy — and
    // nothing is cached. Its gate is off, which is the right answer — but not a
    // silent one, and not a line per request of an outage.
    if (policy._isFallback === true) {
      warnAtMostEvery(
        log,
        "policy-unreadable",
        {},
        "channel-gate: the panel did not answer with a policy and no policy is cached; the gate is off meanwhile",
      );
      return OFF;
    }
    if (policy.channelRequired !== true) return OFF;

    const joinUrl = resolveChannelJoinUrl(policy);
    const user = await telegramUserOf(req);
    if (user.kind === "none") return OFF;
    if (user.kind === "unknown") {
      // Blocked or deleted is an answer, not an outage: end the session the way
      // `/session` and `/me` do, instead of asking the panel again on every
      // launch and logging an outage that is not happening. Only those two
      // answers (`invalidateStaleUserSession` decides): any other refusal says
      // nothing about the account, and ending a session over a token the panel
      // and the cabinet disagree on would sign every Mini App user out at once.
      if (await invalidateStaleUserSession(req, user.error)) return null;
      warnAtMostEvery(
        log,
        "panel-lookup",
        { err: describeUpstreamError(user.error).message },
        "channel-gate: the panel could not say which Telegram user this account is; letting the user in unverified",
      );
      return { status: "unverified", joinUrl };
    }
    if (telegram === null) {
      if (!missingTokenLogged) {
        missingTokenLogged = true;
        log.warn(
          "channel-gate: «Канал обязателен» is on but BOT_TOKEN is not set for the API, so the Mini App cannot check anybody; everyone is let in unverified",
        );
      }
      return { status: "unverified", joinUrl };
    }
    const status = await resolveChannelGateVerdict(
      telegram,
      policy,
      user.id,
      { adminClient, logger: toLoggerPort(log), source: "api", ...(store === undefined ? {} : { store }) },
      { fresh },
    );
    return { status, joinUrl };
  }

  async function answer(req: AuthRequest, res: Response, fresh: boolean): Promise<void> {
    const decision = await decide(req, fresh);
    res.setHeader("Cache-Control", "no-store");
    if (decision === null) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    res.json(decision);
  }

  // The session guard comes FIRST on both: the budgets are counted per account,
  // and a caller that has none is answered 401 before anything is counted.
  router.get("/channel-gate", requireSession, readLimiter, (req: AuthRequest, res) => answer(req, res, false));
  router.post("/channel-gate/check", requireSession, checkLimiter, (req: AuthRequest, res) =>
    answer(req, res, true),
  );

  return router;
}

/** The request's logger in the shape the gate module writes through. */
function toLoggerPort(log: LoggerLike): LoggerPort {
  const port =
    (write: (ctx: object, message: string) => void) =>
    (ctxOrMessage: object | string, message?: string): void => {
      if (typeof ctxOrMessage === "string") write({}, ctxOrMessage);
      else write(ctxOrMessage, message ?? "");
    };
  const error = port((ctx, message) => log.error(ctx, message));
  const debug = port((ctx, message) => log.debug(ctx, message));
  return {
    fatal: error,
    error,
    warn: port((ctx, message) => log.warn(ctx, message)),
    info: port((ctx, message) => log.info(ctx, message)),
    debug,
    trace: debug,
    child: (bindings) => toLoggerPort(log.child(bindings)),
  };
}
