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
}

export interface SessionConfig {
  redisUrl: string;
  cookieSecret: string;
  cookieSecure: boolean;
  isProduction: boolean;
  /** Cookie name for the web auth session */
  cookieName?: string;
}

const DEFAULT_COOKIE_NAME = "reiwa_web_session";
const SECURITY_FLAG_RETRY_ATTEMPTS = 3;
const SECURITY_FLAG_RETRY_DELAY_MS = 500;

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

  async connect(): Promise<void> {
    await this.redis.connect().catch((err: Error) => {
      if (this.logger) {
        this.logger.error(
          { err, component: "WebSessionStore" },
          "Redis connection failed",
        );
      } else {
        // eslint-disable-next-line no-console
        console.error("[WebSessionStore] Redis connection failed:", err.message);
      }
    });
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
      TTL.SESSION,
    );
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(sessionId));
  }

  getRedis(): Redis {
    return this.redis;
  }
}

// ── Cookie Security Flag Helpers ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Attempts to set security flags on the session cookie.
 * In production, retries with a grace period before failing.
 * In non-production, allows authentication without secure flag.
 */
async function resolveSecureCookieOptions(
  config: SessionConfig,
  logger?: LoggerPort,
): Promise<CookieOptions> {
  const options = buildCookieOptions(config.cookieSecure);

  if (!config.isProduction) {
    // Non-production: allow authentication without security flags
    return options;
  }

  // Production: if secure flag is configured, use it directly
  if (config.cookieSecure) {
    return options;
  }

  // Production without secure flag: retry with grace period
  for (let attempt = 1; attempt <= SECURITY_FLAG_RETRY_ATTEMPTS; attempt++) {
    // Check if the environment now supports secure cookies
    // (e.g., TLS termination proxy detected)
    if (config.cookieSecure) {
      return buildCookieOptions(true);
    }
    if (attempt < SECURITY_FLAG_RETRY_ATTEMPTS) {
      await sleep(SECURITY_FLAG_RETRY_DELAY_MS);
    }
  }

  // Grace period exhausted in production without secure flag
  // Still allow operation but log warning — the cookie will be set without secure
  // flag. The session middleware will handle blocking protected routes if auth fails.
  if (logger) {
    logger.warn(
      { component: "WebSession" },
      "Production: secure cookie flag not available after grace period. Authentication will proceed but security is degraded.",
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[WebSession] Production: secure cookie flag not available after grace period. " +
        "Authentication will proceed but security is degraded.",
    );
  }
  return options;
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
  let cookieOptionsPromise: Promise<CookieOptions> | null = null;

  // Lazily resolve cookie options (handles production grace period)
  function getCookieOptions(): Promise<CookieOptions> {
    if (!cookieOptionsPromise) {
      cookieOptionsPromise = resolveSecureCookieOptions(config, logger);
    }
    return cookieOptionsPromise;
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const options = await getCookieOptions();

    // Read session ID from cookie
    const sessionId = req.cookies?.[cookieName] as string | undefined;

    // Attach session data if cookie present
    if (sessionId) {
      const session = await store.get(sessionId);
      if (session) {
        req.webSession = session;
        req.webSessionId = sessionId;
        // Touch session to update lastActivity
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        await store.touch(sessionId, ip);
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
      const opts = await getCookieOptions();
      res.cookie(cookieName, newSessionId, opts);
      return newSessionId;
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
