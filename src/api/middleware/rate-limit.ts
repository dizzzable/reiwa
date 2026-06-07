import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import type { Redis } from "ioredis";

import { getRequestLogger } from "./logger-accessor.js";
import {
  rateLoginKey,
  rateRegisterKey,
  rateRecoverKey,
  bannedIpKey,
  TTL,
} from "../../infrastructure/redis/keys.js";

// ── Generic in-memory rate limiter (express-rate-limit) ─────────────────────

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Rate limit exceeded" },
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
  skip: (req) =>
    req.originalUrl.startsWith("/api/v1/realtime/stream") ||
    req.originalUrl.startsWith("/api/v1/webhooks/rezeis"),
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
   * - "ban": permanently ban the IP address (stored in banned_ip:{ip})
   */
  onExceed: "block" | "ban";
  /**
   * When to start blocking:
   * - "at_limit": block when count reaches maxAttempts (e.g., 3rd request blocked)
   * - "after_limit": allow up to maxAttempts, block starting from the next one
   *   (e.g., 5th request proceeds, 6th is blocked)
   */
  blockBehavior: "at_limit" | "after_limit";
}

/**
 * Predefined rate limit configurations per endpoint.
 *
 * Sign-in: 5 requests/15min/IP — hardcoded, block starting from 5th failed attempt
 * Registration: 3 requests/hour/IP — block when 3rd attempt is made (count reaches 3)
 * Recovery: 3 requests/hour/IP — ban IP when rate limit is exceeded
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
    maxAttempts: 3,
    windowSeconds: TTL.RATE_REGISTER,
    keyBuilder: rateRegisterKey,
    onExceed: "block",
    blockBehavior: "at_limit",
  } satisfies RateLimitConfig,

  recover: {
    maxAttempts: 3,
    windowSeconds: TTL.RATE_RECOVER,
    keyBuilder: rateRecoverKey,
    onExceed: "ban",
    blockBehavior: "at_limit",
  } satisfies RateLimitConfig,
} as const;

export type RateLimitEndpoint = keyof typeof RATE_LIMITS;

/**
 * Creates a Redis-based rate limiting middleware for a specific endpoint.
 *
 * Behavior:
 * - Checks if the IP is banned (banned_ip:{ip} key exists) — returns 429 immediately
 * - Checks the current request count against the configured threshold
 * - If within limits: increments the counter and allows the request through
 * - If exceeded: returns 429 with Retry-After header
 * - If Redis is unavailable: allows the request (fail-open) when no rate limits
 *   have been exceeded; returns 503 when rate limit status cannot be determined
 *
 * @param redis - ioredis instance (or null if unavailable)
 * @param endpoint - The endpoint type to rate limit
 */
export function createRedisRateLimiter(
  redis: Redis | null,
  endpoint: RateLimitEndpoint,
) {
  const config: RateLimitConfig = RATE_LIMITS[endpoint];

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
        res.setHeader("Retry-After", String(config.windowSeconds));
        res.status(429).json({
          message: "Too many requests. Your IP has been temporarily blocked.",
          retryAfter: config.windowSeconds,
        });
        return;
      }

      const key = config.keyBuilder(ip);
      const currentCountStr = await redis.get(key);
      const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;

      // Determine if this request should be blocked
      const shouldBlock =
        config.blockBehavior === "at_limit"
          ? currentCount >= config.maxAttempts
          : currentCount > config.maxAttempts;

      if (shouldBlock) {
        // Rate limit exceeded — return 429 with Retry-After
        const ttl = await redis.ttl(key);
        const retryAfter = ttl > 0 ? ttl : config.windowSeconds;

        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          message: "Too many requests, please try again later",
          retryAfter,
        });
        return;
      }

      // Increment the counter
      const newCount = await redis.incr(key);

      // Set TTL on first increment (when key was just created)
      if (newCount === 1) {
        await redis.expire(key, config.windowSeconds);
      }

      // After incrementing, check if we've now hit the limit
      const nowExceeded =
        config.blockBehavior === "at_limit"
          ? newCount >= config.maxAttempts
          : newCount > config.maxAttempts;

      if (nowExceeded && config.blockBehavior === "at_limit") {
        // For "at_limit" behavior: the request that hits the limit is also blocked
        const ttl = await redis.ttl(key);
        const retryAfter = ttl > 0 ? ttl : config.windowSeconds;

        // If this endpoint bans on exceed, ban the IP
        if (config.onExceed === "ban") {
          await redis.set(
            bannedIpKey(ip),
            JSON.stringify({
              reason: `Rate limit exceeded on ${endpoint}`,
              bannedAt: new Date().toISOString(),
            }),
          );
        }

        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          message: "Too many requests, please try again later",
          retryAfter,
        });
        return;
      }

      // For "after_limit" behavior: check if we just exceeded after increment
      if (nowExceeded && config.blockBehavior === "after_limit") {
        const ttl = await redis.ttl(key);
        const retryAfter = ttl > 0 ? ttl : config.windowSeconds;

        if (config.onExceed === "ban") {
          await redis.set(
            bannedIpKey(ip),
            JSON.stringify({
              reason: `Rate limit exceeded on ${endpoint}`,
              bannedAt: new Date().toISOString(),
            }),
          );
        }

        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          message: "Too many requests, please try again later",
          retryAfter,
        });
        return;
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
