/**
 * Express Session Middleware with Redis Store
 *
 * Configures session middleware using connect-redis with:
 * - httpOnly, sameSite=lax, secure flags
 * - Production: grace period with retry before failing if security flags cannot be set
 * - Non-production: allows authentication without security flags
 * - 24h session TTL
 */

import type { RequestHandler, Request, Response, NextFunction } from "express";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";

import type { LoggerPort } from "../../application/ports/logger.port.js";

import { sessionKey, TTL } from "./keys.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface WebSession {
  userId: string;
  createdAt: number;
  ip: string;
  lastActivity: number;
  /** True once the user opened the cabinet as an installed PWA (standalone).
   *  Standalone sessions get the 30-day TTL instead of the default 24h. */
  standalone?: boolean;
  /** Latest-seen PWA platform (`ios`/`android`/`desktop`). */
  platform?: string;
}

export interface SessionConfig {
  redisUrl: string;
  cookieSecure: boolean;
  isProduction: boolean;
  /**
   * Explicit opt-in to issue non-`Secure` session cookies in production.
   * When false (default), production refuses to start without
   * `cookieSecure` so a misconfigured TLS terminator can't silently
   * downgrade session security. Sourced from `REIWA_ALLOW_INSECURE_COOKIES`.
   */
  allowInsecureCookies?: boolean;
  /** Cookie name for the web auth session */
  cookieName?: string;
}

const DEFAULT_COOKIE_NAME = "reiwa_web_session";

// ── Session Store (Redis-backed) ────────────────────────────────────────────

export interface WebSessionStoreOptions {
  /**
   * Optional structured logger. When omitted (legacy callers, tests),
   * Redis errors fall back to `console.error` so the operator still
   * sees the failure on stderr.
   */
  readonly logger?: LoggerPort;
}

export class WebSessionStore {
  private redis: Redis;
  private logger: LoggerPort | undefined;

  constructor(redisUrl: string, options: WebSessionStoreOptions = {}) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
    this.logger = options.logger;
    this.redis.on("error", (err: Error) => {
      if (this.logger) {
        this.logger.warn({ err, component: "WebSessionStore" }, "Redis error");
      } else {
        // eslint-disable-next-line no-console
        console.error("[WebSessionStore] Redis error:", err.message);
      }
    });
  }

  /**
   * Establish the Redis connection. Rejects on failure so the caller can
   * decide whether to fail-closed (production) or boot in degraded mode
   * (`REIWA_ALLOW_DEGRADED` / non-production). Transient post-connect
   * errors are surfaced separately via the `error` event handler above.
   */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }

  async create(data: Omit<WebSession, "createdAt" | "lastActivity" | "ip">, ip: string): Promise<string> {
    const sessionId = uuidv4();
    const now = Date.now();
    const session: WebSession = {
      ...data,
      ip,
      createdAt: now,
      lastActivity: now,
    };
    await this.redis.set(
      sessionKey(sessionId),
      JSON.stringify(session),
      "EX",
      TTL.SESSION,
    );
    return sessionId;
  }

  async get(sessionId: string): Promise<WebSession | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WebSession;
    } catch {
      return null;
    }
  }

  async touch(sessionId: string, ip: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;
    session.lastActivity = Date.now();
    session.ip = ip;
    await this.redis.set(
      sessionKey(sessionId),
      JSON.stringify(session),
      "EX",
      sessionTtlSeconds(session),
    );
  }

  /**
   * Mark a session as an installed-PWA (standalone) session and re-persist it
   * with the 30-day TTL. Idempotent: re-reports just refresh the platform +
   * extend the window. Returns the updated session (or null if it's gone).
   */
  async setStandalone(sessionId: string, platform: string): Promise<WebSession | null> {
    const session = await this.get(sessionId);
    if (!session) return null;
    session.standalone = true;
    session.platform = platform;
    session.lastActivity = Date.now();
    await this.redis.set(
      sessionKey(sessionId),
      JSON.stringify(session),
      "EX",
      sessionTtlSeconds(session),
    );
    return session;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(sessionId));
  }

  getRedis(): Redis {
    return this.redis;
  }
}

// ── Cookie Security Flag Helpers ────────────────────────────────────────────

/** TTL (seconds) for a session — 30 days when standalone (installed PWA), else 24h. */
function sessionTtlSeconds(session: WebSession): number {
  return session.standalone === true ? TTL.SESSION_PWA : TTL.SESSION;
}

interface CookieOptions {
  httpOnly: boolean;
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
  path: string;
  maxAge: number;
}

function buildCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: TTL.SESSION * 1000, // convert seconds to milliseconds
  };
}

/**
 * Resolve the session-cookie options once at middleware construction.
 *
 * Decision matrix:
 *   - Non-production: honour `cookieSecure` as-is (usually false for
 *     plain-HTTP local dev). No hard failure.
 *   - Production + `cookieSecure=true`: issue `Secure` cookies. ✅
 *   - Production + `cookieSecure=false` + `allowInsecureCookies=true`:
 *     issue non-`Secure` cookies but log a loud warning. Escape hatch
 *     for trusted internal networks / out-of-band TLS.
 *   - Production + `cookieSecure=false` + `allowInsecureCookies=false`
 *     (default): **fail closed** — throw at startup. Previously this
 *     path "retried" a static boolean (dead code) and then silently
 *     degraded to insecure cookies, which is exactly the footgun we now
 *     refuse to ship.
 */
function resolveSecureCookieOptions(
  config: SessionConfig,
  logger?: LoggerPort,
): CookieOptions {
  if (!config.isProduction) {
    return buildCookieOptions(config.cookieSecure);
  }

  if (config.cookieSecure) {
    return buildCookieOptions(true);
  }

  if (config.allowInsecureCookies) {
    const msg =
      "Production: REIWA_COOKIE_SECURE is false and REIWA_ALLOW_INSECURE_COOKIES=true. " +
      "Session cookies will be issued WITHOUT the Secure flag — only safe behind out-of-band TLS or on a trusted internal network.";
    if (logger) {
      logger.warn({ component: "WebSession" }, msg);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[WebSession] ${msg}`);
    }
    return buildCookieOptions(false);
  }

  // Fail closed: refuse to boot rather than silently downgrade.
  throw new Error(
    "Refusing to start in production without secure session cookies. " +
      "Set REIWA_COOKIE_SECURE=true (recommended, requires TLS in front of reiwa) " +
      "or explicitly opt in with REIWA_ALLOW_INSECURE_COOKIES=true for trusted internal deployments.",
  );
}

// ── Session Middleware Factory ───────────────────────────────────────────────

/**
 * Creates Express session middleware that:
 * 1. Reads the session cookie from the request
 * 2. Loads the session from Redis
 * 3. Attaches session data to `req.webSession`
 * 4. Provides `req.createWebSession()` and `req.destroyWebSession()` helpers
 */
export function createWebSessionMiddleware(
  store: WebSessionStore,
  config: SessionConfig,
  logger?: LoggerPort,
): RequestHandler {
  const cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
  // Resolve cookie options eagerly at construction. In production this
  // throws (fail-closed) when secure cookies are neither available nor
  // explicitly waived, so a misconfigured deploy crashes at startup
  // instead of silently issuing insecure session cookies.
  const cookieOptions = resolveSecureCookieOptions(config, logger);
  // 30-day variant for installed-PWA (standalone) sessions — same security
  // flags, longer maxAge.
  const pwaCookieOptions: CookieOptions = {
    ...cookieOptions,
    maxAge: TTL.SESSION_PWA * 1000,
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    // Read session ID from cookie
    const sessionId = req.cookies?.[cookieName] as string | undefined;

    // Attach session data if cookie present
    if (sessionId) {
      const session = await store.get(sessionId);
      if (session) {
        req.webSession = session;
        req.webSessionId = sessionId;
        // Touch session to update lastActivity (slides the Redis TTL).
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        await store.touch(sessionId, ip);
        // Slide the COOKIE too: re-issue it with a fresh maxAge so an actively
        // used session never expires out from under the user. Without this the
        // cookie kept its original 24h lifetime from login regardless of
        // activity — a home-screen PWA would force a re-login every 24h even
        // for daily users. The Redis TTL already slides on touch; this keeps
        // the browser-side cookie in lockstep. Installed-PWA (standalone)
        // sessions slide on the 30-day window.
        res.cookie(
          cookieName,
          sessionId,
          session.standalone === true ? pwaCookieOptions : cookieOptions,
        );
      } else {
        // Server-side session missing while cookie remains — clear stale cookie
        res.clearCookie(cookieName, { path: "/" });
        req.webSession = null;
        req.webSessionId = null;
      }
    } else {
      req.webSession = null;
      req.webSessionId = null;
    }

    // Attach helper: create a new web session
    req.createWebSession = async (userId: string): Promise<string> => {
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const newSessionId = await store.create({ userId }, ip);
      res.cookie(cookieName, newSessionId, cookieOptions);
      return newSessionId;
    };

    // Attach helper: upgrade the current session to an installed-PWA session.
    req.markSessionStandalone = async (platform: string): Promise<void> => {
      if (!req.webSessionId) return;
      const updated = await store.setStandalone(req.webSessionId, platform);
      if (updated) {
        req.webSession = updated;
        res.cookie(cookieName, req.webSessionId, pwaCookieOptions);
      }
    };

    // Attach helper: destroy the current web session
    req.destroyWebSession = async (): Promise<void> => {
      if (req.webSessionId) {
        await store.destroy(req.webSessionId);
        res.clearCookie(cookieName, { path: "/" });
        req.webSession = null;
        req.webSessionId = null;
      }
    };

    next();
  };
}
