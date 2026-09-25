import { isIPv4, isIPv6 } from "node:net";

import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import type { Redis } from "ioredis";

import { getRequestLogger } from "./logger-accessor.js";
import { resolveUserIdentity } from "./user-identity.js";
import {
  rateLoginKey,
  rateRegisterKey,
  rateRecoverKey,
  rateGuestCreateKey,
  rateGuestReplyKey,
  rateGuestUploadKey,
  rateTicketUploadKey,
  rateAiChatKey,
  ratePaymentMethodSetupKey,
  bannedIpKey,
  TTL,
} from "../../infrastructure/redis/keys.js";

// ── Shared 429 presentation helpers ─────────────────────────────────────────

// OAuth start/callback are always opened as *top-level browser documents*, so a
// 429 there must route people back into the localized sign-in UI instead of
// dumping raw JSON into Telegram's in-app browser. `Accept: text/html` alone is
// an unreliable signal for that browser (it frequently sends `*/*`), so treat a
// GET as a navigation when any of these hold: the modern `Sec-Fetch-Dest:
// document` hint, the request path is an OAuth start/callback (which can only be
// reached via navigation), or the classic `Accept: text/html`.
const OAUTH_NAVIGATION_PATH = /^\/api\/v1\/auth\/ext\/[^/]+\/(start|callback)\b/;

/** `GET /api/v1/config-versions` exactly (a query string allowed) — see `apiLimiter`. */
const CONFIG_VERSIONS_PATH = /^\/api\/v1\/config-versions(?:[?#]|$)/;

export function isBrowserNavigation(req: Request): boolean {
  if (req.method !== "GET") {
    return false;
  }
  const secFetchDest = req.headers?.["sec-fetch-dest"];
  if (secFetchDest === "document") {
    return true;
  }
  const originalUrl = typeof req.originalUrl === "string" ? req.originalUrl : "";
  if (OAUTH_NAVIGATION_PATH.test(originalUrl)) {
    return true;
  }
  const accept = req.headers?.accept ?? "";
  return typeof accept === "string" && accept.includes("text/html");
}

function redirectToSignIn(res: Response, retryAfter: number): void {
  res.redirect(
    303,
    `/sign-in?rate_limited=1&retry_after=${encodeURIComponent(String(retryAfter))}`,
  );
}

/**
 * Handler for the generic in-memory limiters. Mirrors the Redis limiter's
 * contract: real `Retry-After`, a localized redirect for browser navigations,
 * and a structured `{ message, retryAfter }` body (fetch/XHR consumers, e.g.
 * the TMA bootstrap countdown, depend on `retryAfter` — without it they fall
 * back to a hardcoded guess that no longer matches the real window).
 */
function createGenericLimitHandler(fallbackWindowMs: number) {
  const fallbackSeconds = Math.ceil(fallbackWindowMs / 1000);
  return (req: Request, res: Response, _next: NextFunction, options: { statusCode: number; message: unknown }): void => {
    const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
    const retryAfter =
      resetTime instanceof Date
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : fallbackSeconds;
    res.setHeader("Retry-After", String(retryAfter));
    if (isBrowserNavigation(req)) {
      redirectToSignIn(res, retryAfter);
      return;
    }
    const rawMessage = options.message;
    const message =
      typeof rawMessage === "object" && rawMessage !== null && "message" in rawMessage
        ? String((rawMessage as { message: unknown }).message)
        : "Too many requests, please try again later";
    res.status(options.statusCode).json({ message, retryAfter });
  };
}

// ── Generic in-memory rate limiter (express-rate-limit) ─────────────────────

const AUTH_LIMITER_WINDOW_MS = 15 * 60 * 1000;
const API_LIMITER_WINDOW_MS = 60 * 1000;

export const authLimiter = rateLimit({
  windowMs: AUTH_LIMITER_WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
  handler: createGenericLimitHandler(AUTH_LIMITER_WINDOW_MS),
});

export const apiLimiter = rateLimit({
  windowMs: API_LIMITER_WINDOW_MS,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Rate limit exceeded" },
  handler: createGenericLimitHandler(API_LIMITER_WINDOW_MS),
  // The realtime SSE endpoint holds a single long-lived connection per
  // tab and auto-reconnects via `EventSource`. Counting each reconnect
  // against the generic 120/min budget lets a flaky network lock the
  // user out of their own event stream, so it gets excluded here and
  // relies on the per-session auth + upstream connection limits instead.
  // `originalUrl` is used because the limiter is mounted at `/api`, which
  // strips the prefix from `req.path`.
  // - SSE stream: long-lived, auto-reconnect would burn the budget.
  // - rezeis webhook receiver: server-to-server delivery (signature-authed,
  //   not IP/browser traffic); a 429 here would drop operator events.
  // - OAuth start/callback (GET): top-level navigations that are already gated
  //   by the per-route Redis `loginRateLimiter`, which renders the localized
  //   waiting screen. Letting the generic limiter fire first would race it and
  //   could still surface raw JSON, so defer entirely to the per-route gate.
  // - The settings version check (GET): every visible tab asks it once a
  //   minute (`web/src/lib/config-versions.ts`), and it is answered from the
  //   process's memory — nothing upstream to protect. Counted, many open
  //   cabinets behind one carrier NAT address spent the shared budget on it and
  //   real calls got 429 (review R2a-10).
  skip: (req) =>
    req.originalUrl.startsWith("/api/v1/realtime/stream") ||
    req.originalUrl.startsWith("/api/v1/webhooks/rezeis") ||
    (req.method === "GET" && OAUTH_NAVIGATION_PATH.test(req.originalUrl)) ||
    (req.method === "GET" && CONFIG_VERSIONS_PATH.test(req.originalUrl)),
});

/**
 * An in-memory budget counted per signed-in ACCOUNT instead of per address.
 *
 * For a route whose cost lands on the person — the channel gate's re-check asks
 * Telegram about one user each time — an address is the wrong unit both ways: a
 * carrier NAT pool shares one, so one impatient tapper would spend the allowance
 * of everybody behind it, while one account on a rotating mobile address would
 * not be bounded at all. The Redis limiters below can only key by address.
 *
 * Mount it AFTER the session guard. The key is the session's identity — the
 * reiwa_id, or the legacy session's Telegram id — and by then a request without
 * one has already been answered 401. The API runs as one process, so a counter
 * in memory sees every request. The 429 is the generic limiters' own:
 * `Retry-After` and `{ message, retryAfter }`.
 */
export function createAccountRateLimiter(options: {
  readonly windowMs: number;
  readonly limit: number;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests, please try again later" },
    handler: createGenericLimitHandler(options.windowMs),
    keyGenerator: (req) => {
      const identity = resolveUserIdentity(req);
      if (identity.userId !== undefined) return `account:${identity.userId}`;
      if (identity.telegramId !== undefined) return `telegram:${identity.telegramId}`;
      return "anonymous";
    },
  });
}

// ── Redis-based endpoint-specific rate limiters ─────────────────────────────

/**
 * Rate limit configuration for a specific endpoint type.
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window */
  maxAttempts: number;
  /** TTL for the rate limit window in seconds */
  windowSeconds: number;
  /** Redis key builder function */
  keyBuilder: (ip: string) => string;
  /**
   * Behavior when the limit is exceeded:
   * - "block": continue blocking subsequent requests within the window
   * - "ban": block every endpoint for this IP for `TTL.BANNED_IP` (stored in
   *   banned_ip:{ip}); self-expiring rather than permanent, because IPv4 is
   *   shared — a carrier NAT pool would otherwise be locked out by one abuser
   */
  onExceed: "block" | "ban";
  /**
   * When to start blocking:
   * - "at_limit": block when count reaches maxAttempts (e.g., 3rd request blocked)
   * - "after_limit": allow up to maxAttempts, block starting from the next one
   *   (e.g., 5th request proceeds, 6th is blocked)
   */
  blockBehavior: "at_limit" | "after_limit";
  /**
   * When true, an attempt that plainly created nothing is given back to the
   * budget once the response is known (see `isRefundableOutcome`).
   *
   * This matters because the limiter is middleware: it counts before the handler
   * can tell whether anything happened. A budget meant to cap *accounts* was
   * being spent on rejected form submissions, so a fumbled password or a server
   * hiccup cost the caller — and everyone else sharing their IP — the same as a
   * real signup.
   */
  refundFailedAttempts?: boolean;
}

/**
 * Whether a finished response should give its attempt back.
 *
 * An explicit allowlist of the statuses the register route can produce *before*
 * an account can exist: 400 from schema validation, 403 from the registration
 * mode gate, 409 for a login that is already taken.
 *
 * 5xx is deliberately absent. The handler answers `500 Account created but
 * session setup failed` after the upstream account was created, so refunding
 * 5xx would hand a slot back for a real account and uncap the limit precisely
 * during an incident — the opposite of what the budget is for.
 *
 * 409 is refunded even though it reveals that a login exists, because
 * `POST /auth/check-username` already answers that question and is outside this
 * limiter entirely: charging a real user for "that name is taken" buys no
 * enumeration protection while costing everyone behind their IP a slot. Meter
 * enumeration on that endpoint, not here.
 */
function isRefundableOutcome(statusCode: number): boolean {
  return statusCode === 400 || statusCode === 403 || statusCode === 409;
}

/**
 * Predefined rate limit configurations per endpoint.
 *
 * Sign-in: 5 requests/15min/IP — 5 attempts pass, the 6th is blocked
 * Registration: 5 signups/hour/IP — the 6th is blocked; attempts that created
 *   nothing (400/422/5xx) are refunded, so the budget caps accounts, not typos
 * Recovery: 3 requests/hour per address (an IPv6 /64) — 3 pass, the 4th is
 *   blocked for the remaining window
 * Password reset by link, reading a link's state, and recovery by subscription
 *   link each have their own budget per address (an IPv6 /64) — see below.
 */
export const RATE_LIMITS = {
  login: {
    maxAttempts: 5,
    windowSeconds: TTL.RATE_LOGIN,
    keyBuilder: rateLoginKey,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  register: {
    // Five real signups per hour per IP. It used to read 3 with "at_limit",
    // which refused the 3rd request — an advertised 3 that behaved like 2, and
    // every rejected form submission counted, so two typos exhausted the hour
    // for an entire carrier NAT pool.
    maxAttempts: 5,
    windowSeconds: TTL.RATE_REGISTER,
    keyBuilder: rateRegisterKey,
    onExceed: "block",
    blockBehavior: "after_limit",
    refundFailedAttempts: true,
  } satisfies RateLimitConfig,

  recover: {
    maxAttempts: 3,
    windowSeconds: TTL.RATE_RECOVER,
    keyBuilder: (ip) => rateRecoverKey(ipRateBucket(ip)),
    // Blocks recovery for the window instead of locking the IP out of every
    // endpoint for a day: three recovery attempts is a person who forgot which
    // login they used, and behind CGNAT the day-long ban lands on bystanders.
    onExceed: "block",
    // Three pass. It read "at_limit", which refused the 3rd — an advertised 3
    // that behaved like 2, the same defect `register` had.
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // Setting a new password with a reset link. A sign-in in all but name — it
  // ends in a session — but with its own counter: sharing the sign-in form's
  // would let a few wrong passwords block the reset that fixes them, and the
  // other way round. The link itself is single-use and 32 random bytes, so
  // this bounds load, not guessing.
  passwordReset: {
    maxAttempts: 10,
    windowSeconds: 15 * 60,
    keyBuilder: (ip) => `rate:pwreset:${ipRateBucket(ip)}`,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // Reading a reset link's state — once per page load, and again on a retry.
  // Kept apart from `authLimiter`, whose 20 per 15 minutes the Mini App
  // bootstrap and Telegram linking spend too.
  passwordResetInspect: {
    maxAttempts: 30,
    windowSeconds: 15 * 60,
    keyBuilder: (ip) => `rate:pwreset_inspect:${ipRateBucket(ip)}`,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // Recovery by subscription link. The panel meters the same address at 5 an
  // hour and every account a link names at 5 a day; this outer budget keeps a
  // flood from reaching the panel at all.
  recoverSubscription: {
    maxAttempts: 10,
    windowSeconds: 60 * 60,
    keyBuilder: (ip) => `rate:recover_sub:${ipRateBucket(ip)}`,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // Anonymous guest support: open at most 5 conversations/hour/IP (bounds the
  // number of concurrent open guest conversations from one source) …
  guestCreate: {
    maxAttempts: 5,
    windowSeconds: TTL.RATE_GUEST_CREATE,
    keyBuilder: rateGuestCreateKey,
    onExceed: "block",
    blockBehavior: "at_limit",
  } satisfies RateLimitConfig,

  // … and at most 30 messages/minute/IP on an open conversation.
  guestReply: {
    maxAttempts: 30,
    windowSeconds: TTL.RATE_GUEST_REPLY,
    keyBuilder: rateGuestReplyKey,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // Attachment uploads are heavier (base64 body up to ~13 MB) — a tighter
  // 12/minute/IP budget, separate from the text-reply limiter.
  guestUpload: {
    maxAttempts: 12,
    windowSeconds: TTL.RATE_GUEST_UPLOAD,
    keyBuilder: rateGuestUploadKey,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // The same budget for a SIGNED-IN customer's upload. It had none at all,
  // while the anonymous route beside it did — so the one path that costs disk
  // per request was the one nobody bounded.
  ticketUpload: {
    maxAttempts: 12,
    windowSeconds: TTL.RATE_TICKET_UPLOAD,
    keyBuilder: rateTicketUploadKey,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // AI chat — each message fans out to up to two paid LLM completions, so keep
  // a tight 15/minute/IP budget on top of the required session auth.
  aiChat: {
    maxAttempts: 15,
    windowSeconds: TTL.RATE_AI_CHAT,
    keyBuilder: rateAiChatKey,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,

  // Card binding: each attempt opens a real zero-amount request against
  // YooKassa, so keep a tight 5/10min/IP budget on top of the required
  // session auth to prevent spamming provider bind requests.
  paymentMethodSetup: {
    maxAttempts: 5,
    windowSeconds: TTL.RATE_PAYMENT_METHOD_SETUP,
    keyBuilder: ratePaymentMethodSetupKey,
    onExceed: "block",
    blockBehavior: "after_limit",
  } satisfies RateLimitConfig,
} as const;

export type RateLimitEndpoint = keyof typeof RATE_LIMITS;

/**
 * The unit an address budget counts in.
 *
 * IPv4: the address. IPv6: its /64 — one subscriber line is handed a whole
 * /64 (often a /56), so a budget keyed on the full address is 2^64 budgets for
 * one person. An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`, how a
 * dual-stack socket reports IPv4) counts as the IPv4 address it carries.
 * Anything that is not an address is its own key, unchanged.
 */
export function ipRateBucket(ip: string): string {
  const raw = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped !== null && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(raw)) return raw;
  const address = raw.split("%", 1)[0] ?? "";
  if (!isIPv6(address)) return raw;
  const hextets = expandIPv6(address);
  return hextets === null ? raw : `${hextets.slice(0, 4).join(":")}::/64`;
}

/** The eight hextets of a valid IPv6 address, lower-case and unpadded, or `null`. */
function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase();
  // A trailing embedded IPv4 (`64:ff9b::192.0.2.1`) is the last two hextets.
  const embedded = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (embedded !== null) {
    const [a, b, c, d] = embedded.slice(1).map(Number);
    text = `${text.slice(0, embedded.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => "0"), ...tail];
  return all.map((part) => (Number.parseInt(part, 16) || 0).toString(16));
}

const INCREMENT_WITH_TTL_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = redis.call("TTL", KEYS[1])
end
return { count, ttl }
`;

/**
 * Give one attempt back without resurrecting an expired window, crossing into
 * the next one, or going negative.
 *
 * `EXISTS` keeps an expired window absent rather than recreating it with a fresh
 * hour. The TTL comparison against the value observed at increment time is what
 * keeps a late refund out of the *next* window: within one window the TTL only
 * counts down, so a larger TTL than we saw means the key we are looking at is a
 * new window and the attempt we are refunding no longer exists. Without it, a
 * response finishing just after the hour rolled over would decrement a fresh
 * counter and let more accounts through than the cap allows.
 *
 * DECR leaves the TTL alone, so refunding never moves the window's end.
 */
const REFUND_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
local ttl = redis.call("TTL", KEYS[1])
if ttl > tonumber(ARGV[1]) then return 0 end
local count = tonumber(redis.call("GET", KEYS[1]) or "0")
if count <= 0 then return 0 end
return redis.call("DECR", KEYS[1])
`;

/**
 * Creates a Redis-based rate limiting middleware for a specific endpoint.
 *
 * Behavior:
 * - Checks if the IP is banned (banned_ip:{ip} key exists) — returns 429 immediately
 * - Atomically increments the request count and sets its expiry on first use
 * - If within limits: allows the request through
 * - If exceeded: returns 429 with Retry-After header
 * - If Redis is unavailable or returns an invalid result: fails closed with 503
 *
 * @param redis - ioredis instance (or null if unavailable)
 * @param endpoint - The endpoint type to rate limit
 */
export function createRedisRateLimiter(
  redis: Redis | null,
  endpoint: RateLimitEndpoint,
) {
  const config: RateLimitConfig = RATE_LIMITS[endpoint];

  const reject = (req: Request, res: Response, retryAfter: number, message: string): void => {
    // `originalUrl` is always populated by Express. Keeping this guard also
    // lets isolated middleware tests use a minimal request double without
    // producing hundreds of fallback console logs.
    if (typeof req.originalUrl === 'string') {
      getRequestLogger(req).warn(
        {
          component: 'rate-limit',
          endpoint,
          originalUrl: req.originalUrl,
          method: req.method,
          ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
          retryAfter,
        },
        'Rate limit request rejected',
      );
    }
    res.setHeader('Retry-After', String(retryAfter));

    // OAuth starts/callbacks are opened as top-level browser documents. Keep
    // fetch/XHR on the structured 429 contract, but route people back into the
    // localized sign-in UI instead of showing raw JSON in Telegram's browser.
    if (isBrowserNavigation(req)) {
      redirectToSignIn(res, retryAfter);
      return;
    }
    res.status(429).json({ message, retryAfter });
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

    // If Redis is not available at all, we cannot determine rate limit status
    if (!redis) {
      res.status(503).json({
        message: "Service temporarily unavailable",
      });
      return;
    }

    try {
      // Check if IP is permanently banned
      const banned = await redis.get(bannedIpKey(ip));
      if (banned) {
        // Banned IPs always get 429 — this is an actual rate limit violation
        reject(req, res, config.windowSeconds, 'Too many requests. Your IP has been temporarily blocked.');
        return;
      }

      const key = config.keyBuilder(ip);
      const result = await redis.eval(
        INCREMENT_WITH_TTL_SCRIPT,
        1,
        key,
        config.windowSeconds,
      );
      if (
        !Array.isArray(result) ||
        result.length !== 2 ||
        !result.every((value) => typeof value === "number" && Number.isInteger(value))
      ) {
        throw new Error("Invalid Redis rate-limit script result");
      }
      const [newCount, ttl] = result;
      const retryAfter = ttl > 0 ? ttl : config.windowSeconds;

      // After incrementing, check if we've now hit the limit
      const nowExceeded =
        config.blockBehavior === "at_limit"
          ? newCount >= config.maxAttempts
          : newCount > config.maxAttempts;

      if (nowExceeded && config.blockBehavior === "at_limit") {
        // For "at_limit" behavior: the request that hits the limit is also blocked
        // If this endpoint bans on exceed, ban the IP
        if (config.onExceed === "ban") {
          // TTL so the ban self-expires (shared/rotating IPs) — see TTL.BANNED_IP.
          await redis.set(
            bannedIpKey(ip),
            JSON.stringify({
              reason: `Rate limit exceeded on ${endpoint}`,
              bannedAt: new Date().toISOString(),
            }),
            "EX",
            TTL.BANNED_IP,
          );
        }

        reject(req, res, retryAfter, 'Too many requests, please try again later');
        return;
      }

      // For "after_limit" behavior: check if we just exceeded after increment
      if (nowExceeded && config.blockBehavior === "after_limit") {
        if (config.onExceed === "ban") {
          // TTL so the ban self-expires (shared/rotating IPs) — see TTL.BANNED_IP.
          await redis.set(
            bannedIpKey(ip),
            JSON.stringify({
              reason: `Rate limit exceeded on ${endpoint}`,
              bannedAt: new Date().toISOString(),
            }),
            "EX",
            TTL.BANNED_IP,
          );
        }

        reject(req, res, retryAfter, 'Too many requests, please try again later');
        return;
      }

      // Registered only on the path that actually consumed an attempt, so a
      // rejected request never refunds a budget it did not spend.
      if (config.refundFailedAttempts === true) {
        res.on("finish", () => {
          if (!isRefundableOutcome(res.statusCode)) return;
          void redis.eval(REFUND_SCRIPT, 1, key, String(ttl)).catch((error: unknown) => {
            getRequestLogger(req).warn(
              { err: error, component: "rate-limit", endpoint },
              "Failed to refund rate-limit attempt",
            );
          });
        });
      }

      // Request is within limits — proceed
      next();
    } catch (error) {
      // Redis operation failed — cannot determine rate limit status
      // Return 503 since we can't verify whether limits have been exceeded
      const reqLogger = getRequestLogger(req);
      reqLogger.error(
        { err: error, component: "rate-limit", endpoint },
        "Redis error during rate-limit check",
      );
      res.status(503).json({
        message: "Service temporarily unavailable",
      });
    }
  };
}
