/**
 * Express Session Middleware with Redis Store
 *
 * Configures session middleware using connect-redis with:
 * - httpOnly, sameSite=lax, secure flags
 * - Production: grace period with retry before failing if security flags cannot be set
 * - Non-production: allows authentication without security flags
 * - 30-day session TTL, the same for a tab and an installed PWA
 */

import type { RequestHandler, Request, Response, NextFunction } from "express";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";

import type { LoggerPort } from "../../application/ports/logger.port.js";

import { sessionKey, TTL } from "./keys.js";
import { REDIS_CLIENT_OPTIONS } from "../../lib/redis-client-options.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface WebSession {
  userId: string;
  createdAt: number;
  ip: string;
  lastActivity: number;
  /** True once the user opened the cabinet as an installed PWA (standalone).
   *  Standalone sessions carry `TTL.SESSION_PWA`. The browser window now equals
   *  it, but the two stay separate settings — one can move without the other. */
  standalone?: boolean;
  /** Latest-seen PWA platform (`ios`/`android`/`desktop`). */
  platform?: string;
  /**
   * The panel's `sessionsRevokedAt` (ms) this session was opened by — set when
   * the session belongs to the browser that made the change which signed every
   * other session out: a password change, a reset, a first password, «Выйти на
   * всех устройствах». The session counts as starting at the later of this and
   * `createdAt` (`sessionEpoch`), so its own change never signs it out, whatever
   * the cabinet's clock says against the panel's.
   */
  authFloor?: number;
  /** When this session last asked the panel whether it had been signed out (ms). */
  revocationCheckedAt?: number;
}

// ── Signing sessions out from the panel ─────────────────────────────────────
//
// A session is an opaque key with no index by customer, so nothing here can
// find a customer's sessions to end them. The panel instead keeps one moment
// per account (`web_accounts.sessions_revoked_at`, in Postgres, where memory
// pressure cannot evict it): every session that started before it is signed
// out. Each session asks at most once per `SESSION_REVOCATION_CHECK_INTERVAL_MS`
// — no panel round trip on every request — so a session signed out elsewhere
// keeps working for at most that long before its next request ends it.

/** How often a session asks the panel whether it was signed out: at most once a minute. */
export const SESSION_REVOCATION_CHECK_INTERVAL_MS = 60_000;

/**
 * The panel's answer: `revokedAt` is its moment in ms, `null` when nothing was
 * ever revoked. A `null` verdict means "could not tell" — an older panel, or
 * one that did not answer — and signs nothing out.
 */
export type SessionRevocationVerdict = { readonly revokedAt: number | null } | null;

export type SessionRevocationCheck = (userId: string) => Promise<SessionRevocationVerdict>;

/** When a session counts as having started: the later of its creation and its `authFloor`. */
export function sessionEpoch(session: WebSession): number {
  return Math.max(session.createdAt, session.authFloor ?? 0);
}

/** Whether the panel's verdict signs this session out. */
export function isSignedOutBy(session: WebSession, verdict: SessionRevocationVerdict): boolean {
  return verdict !== null && verdict.revokedAt !== null && sessionEpoch(session) < verdict.revokedAt;
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
    this.redis = new Redis(redisUrl, { ...REDIS_CLIENT_OPTIONS, lazyConnect: true });
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

  async create(
    data: Omit<WebSession, "createdAt" | "lastActivity" | "ip" | "revocationCheckedAt">,
    ip: string,
  ): Promise<string> {
    const sessionId = uuidv4();
    const now = Date.now();
    const session: WebSession = {
      ...data,
      ip,
      createdAt: now,
      lastActivity: now,
      // A session opened now cannot have been signed out before it existed;
      // its first question to the panel is due a full interval from now.
      revocationCheckedAt: now,
    };
    await this.redis.set(
      sessionKey(sessionId),
      JSON.stringify(session),
      "EX",
      sessionTtlSeconds(session),
    );
    return sessionId;
  }

  /**
   * The browser that just signed every other session out gets a fresh one:
   * a NEW id — a copy of the old cookie, wherever it is, stays behind and dies
   * with the rest — that keeps the installed-app flag and counts from
   * `authFloor`. The old session is destroyed. `null` when it is already gone.
   */
  async renew(
    sessionId: string,
    ip: string,
    authFloor: number,
  ): Promise<{ readonly sessionId: string; readonly session: WebSession } | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    const renewedId = await this.create(
      {
        userId: current.userId,
        authFloor,
        ...(current.standalone === true ? { standalone: true } : {}),
        ...(current.platform !== undefined ? { platform: current.platform } : {}),
      },
      ip,
    );
    await this.destroy(sessionId);
    const renewed = await this.get(renewedId);
    return renewed ? { sessionId: renewedId, session: renewed } : null;
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

  /**
   * Slide the session's window. `revocationCheckedAt`, when given, records that
   * the panel was just asked — in the same write, so the check costs Redis
   * nothing extra.
   */
  async touch(sessionId: string, ip: string, revocationCheckedAt?: number): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;
    session.lastActivity = Date.now();
    session.ip = ip;
    if (revocationCheckedAt !== undefined) session.revocationCheckedAt = revocationCheckedAt;
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

/** TTL (seconds) for a session — 30 days either way, from two separate settings. */
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

export interface WebSessionMiddlewareOptions {
  /**
   * Asks the panel whether a customer's sessions were signed out, and when.
   * Absent (no panel configured), nothing is ever signed out this way.
   */
  readonly revocation?: SessionRevocationCheck;
  /**
   * Which request paths may carry that question (all, when absent). The
   * cabinet asks on its API only: a static file must never wait on the panel.
   */
  readonly revocationCheckedPath?: (path: string) => boolean;
}

/**
 * Creates Express session middleware that:
 * 1. Reads the session cookie from the request
 * 2. Loads the session from Redis
 * 3. At most once a minute per session, asks the panel whether the session
 *    was signed out (a password change or reset, «Выйти на всех устройствах»
 *    elsewhere) and ends it if so
 * 4. Attaches session data to `req.webSession`
 * 5. Provides `req.createWebSession()`, `req.renewWebSession()` and
 *    `req.destroyWebSession()` helpers
 */
export function createWebSessionMiddleware(
  store: WebSessionStore,
  config: SessionConfig,
  logger?: LoggerPort,
  options: WebSessionMiddlewareOptions = {},
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
      let session = await store.get(sessionId);
      // Signed out elsewhere? Asked at most once an interval per session; a
      // panel that cannot tell signs nothing out, and is asked again next time.
      let revocationCheckedAt: number | undefined;
      const pathAsks = options.revocationCheckedPath?.(req.path) ?? true;
      if (session && options.revocation && pathAsks) {
        const now = Date.now();
        if (now - (session.revocationCheckedAt ?? 0) >= SESSION_REVOCATION_CHECK_INTERVAL_MS) {
          let verdict: SessionRevocationVerdict = null;
          try {
            verdict = await options.revocation(session.userId);
          } catch (err: unknown) {
            logger?.warn({ err, component: "WebSession" }, "session revocation check failed");
          }
          if (isSignedOutBy(session, verdict)) {
            await store.destroy(sessionId);
            session = null;
          } else {
            revocationCheckedAt = now;
          }
        }
      }
      if (session) {
        req.webSession = session;
        req.webSessionId = sessionId;
        // Touch session to update lastActivity (slides the Redis TTL).
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        await store.touch(sessionId, ip, revocationCheckedAt);
        // Slide the COOKIE too: re-issue it with a fresh maxAge so an actively
        // used session never expires out from under the user. Without this the
        // cookie keeps the lifetime it was handed at sign-in regardless of
        // activity, and the window becomes an absolute cap counted from then —
        // a daily user signed out on a schedule. The Redis TTL already slides
        // on touch; this keeps the browser-side cookie in lockstep, on
        // whichever of the two windows the session carries.
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

    // Attach helper: create a new web session. `authFloor` for a session opened
    // by the change that signed every other session out (a reset).
    req.createWebSession = async (
      userId: string,
      sessionOptions?: { readonly authFloor?: number },
    ): Promise<string> => {
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const authFloor = sessionOptions?.authFloor;
      const newSessionId = await store.create(
        authFloor === undefined ? { userId } : { userId, authFloor },
        ip,
      );
      res.cookie(cookieName, newSessionId, cookieOptions);
      return newSessionId;
    };

    // Attach helper: this browser just signed every other session out (a
    // password change, a first password, «Выйти на всех устройствах»). It
    // continues on a fresh session that counts from `authFloor`.
    req.renewWebSession = async (sessionOptions: { readonly authFloor: number }): Promise<string | null> => {
      if (!req.webSessionId) return null;
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const renewed = await store.renew(req.webSessionId, ip, sessionOptions.authFloor);
      if (!renewed) return null;
      req.webSession = renewed.session;
      req.webSessionId = renewed.sessionId;
      res.cookie(
        cookieName,
        renewed.sessionId,
        renewed.session.standalone === true ? pwaCookieOptions : cookieOptions,
      );
      return renewed.sessionId;
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
