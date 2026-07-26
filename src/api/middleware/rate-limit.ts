import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import type { Redis } from "ioredis";

import { getRequestLogger } from "./logger-accessor.js";
import {
  rateLoginKey,
  rateRegisterKey,
  rateRecoverKey,
  rateGuestCreateKey,
  rateGuestReplyKey,
  rateGuestUploadKey,
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
  skip: (req) =>
    req.originalUrl.startsWith("/api/v1/realtime/stream") ||
    req.originalUrl.startsWith("/api/v1/webhooks/rezeis") ||
    (req.method === "GET" && OAUTH_NAVIGATION_PATH.test(req.originalUrl)),
});

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
 * Recovery: 3 requests/hour/IP — the 3rd is blocked for the remaining window
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
    keyBuilder: rateRecoverKey,
    // Blocks recovery for the window instead of locking the IP out of every
    // endpoint for a day: three recovery attempts is a person who forgot which
    // login they used, and behind CGNAT the day-long ban lands on bystanders.
    onExceed: "block",
    blockBehavior: "at_limit",
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
