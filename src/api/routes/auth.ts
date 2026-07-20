import { Router, Request, Response } from "express";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { diagnoseTelegramInitData, parseUnverifiedTelegramInitData, validateTelegramInitData, validateTelegramWidget } from "../../lib/telegram-auth.js";
import { requireMode } from "../middleware/access-mode.js";
import { authLimiter, createRedisRateLimiter } from "../middleware/rate-limit.js";
import { createSessionMiddleware } from "../middleware/session.js";
import { createAuthBruteForceDetection } from "../middleware/brute-force-detection.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { describeUpstreamError, isUpstreamStatus } from "../lib/upstream-error.js";
import type { AuthRequest } from "../middleware/session.js";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

const utmSchema = z
  .object({
    source: z.string().max(128).optional(),
    medium: z.string().max(128).optional(),
    campaign: z.string().max(128).optional(),
    content: z.string().max(128).optional(),
    term: z.string().max(128).optional(),
    raw: z.string().max(512).optional(),
  })
  .optional();

const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(32, "Username must be at most 32 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username may only contain alphanumeric characters, hyphens, or underscores",
    ),
  passwordHash: z
    .string()
    .length(64, "Password hash must be a 64-character SHA-256 hex string")
    .regex(/^[a-f0-9]+$/i, "Password hash must be a valid hex string"),
  // Optional referral code from the invite link (`/register?ref=<code>`).
  referralCode: z.string().min(1).max(64).optional(),
  // Optional client-side UTM (server still stamps IP/UA/Referer from the request).
  utm: utmSchema,
});

// Claim: mandatory first-entry onboarding for an authenticated Telegram-first
// user who has a `User` but no `WebAccount`. Same field rules as register.
const claimSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(32, "Username must be at most 32 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username may only contain alphanumeric characters, hyphens, or underscores",
    ),
  passwordHash: z
    .string()
    .length(64, "Password hash must be a 64-character SHA-256 hex string")
    .regex(/^[a-f0-9]+$/i, "Password hash must be a valid hex string"),
});

const loginSchema = z.object({
  username: z
    .string()
    .min(1, "Username is required")
    .max(254, "Username exceeds maximum length"),
  passwordHash: z
    .string()
    .min(1, "Password is required")
    .max(128, "Password exceeds maximum length"),
});

const recoverSchema = z.object({
  username: z
    .string()
    .min(1, "Username is required")
    .max(254, "Username exceeds maximum length"),
});

const changePasswordSchema = z.object({
  currentPasswordHash: z
    .string()
    .length(64, "Current password hash must be a 64-character SHA-256 hex string")
    .regex(/^[a-f0-9]+$/i, "Current password hash must be a valid hex string"),
  newPasswordHash: z
    .string()
    .length(64, "New password hash must be a 64-character SHA-256 hex string")
    .regex(/^[a-f0-9]+$/i, "New password hash must be a valid hex string"),
});

// ── Client error shaping ────────────────────────────────────────────────────
// Public Mini App users must never see operator/env diagnostics (Origin/CSRF,
// BOT_TOKEN, REIWA_DOMAIN, upstream dumps). Those go in `debug` only when the
// authenticated Telegram id equals BOT_DEV_ID. Product AccessMode codes are
// public by design and do not use this helper.

function isBotDevTelegramId(
  telegramId: string | null | undefined,
  config: ReiwaConfig,
): boolean {
  if (!telegramId || config.BOT_DEV_ID == null) return false;
  return telegramId === String(config.BOT_DEV_ID);
}

function bootstrapClientError(input: {
  message: string;
  code?: string;
  telegramId?: string | null;
  config: ReiwaConfig;
  debug?: string;
}): { message: string; code?: string; debug?: string } {
  const body: { message: string; code?: string; debug?: string } = {
    message: input.message,
  };
  if (input.code) body.code = input.code;
  if (input.debug && isBotDevTelegramId(input.telegramId, input.config)) {
    body.debug = input.debug;
  }
  return body;
}

// ── Router Factory ──────────────────────────────────────────────────────────

export function createAuthRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  webSessionStore: WebSessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore, webSessionStore, config } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // Get Redis instance for rate limiting and brute-force detection
  const getRedis = () => webSessionStore?.getRedis() ?? null;
  const redis = getRedis();

  // Create endpoint-specific rate limiters
  const loginRateLimiter = createRedisRateLimiter(redis, "login");
  const registerRateLimiter = createRedisRateLimiter(redis, "register");
  const recoverRateLimiter = createRedisRateLimiter(redis, "recover");

  // Create brute-force detection middleware
  const bruteForceDetection = createAuthBruteForceDetection(getRedis);

  // ── GET /api/v1/auth/bot-signin ─────────────────────────────────────────────
  //
  // Magic-link entry point: reiwa-bot embeds `?signin=<token>` into the
  // Cabinet URL it shows in Telegram. The SPA's WebHomePage redirects
  // the browser here on first paint when it sees the query param.
  // Single-use; the token is consumed atomically on the admin side so
  // a refreshed page can't replay the auth.
  //
  // Auth: the token itself. We rate-limit against `loginRateLimiter`
  // because invalid tokens are just as much a brute-force surface as
  // failed passwords — without rate limiting an attacker could try
  // millions of token guesses against the consume endpoint.
  //
  // Returns:
  //   - 200 + `{ success: true, redirectUrl: "/dashboard" }` on success
  //     (cookie is set as a side-effect; SPA does the actual nav).
  //   - 401 + `{ success: false, message: "..." }` on bad / expired token.
  router.post("/auth/bot-signin", loginRateLimiter, async (req: Request, res: Response) => {
    try {
      const token = typeof req.body?.token === "string" ? req.body.token : null;
      if (token === null || token.length !== 64 || !/^[a-f0-9]+$/i.test(token)) {
        res.status(401).json({ success: false, message: "Invalid or expired link" });
        return;
      }
      if (!adminClient) {
        res.status(503).json({ success: false, message: "Service unavailable" });
        return;
      }
      const result = await adminClient.webAuth.consumeBotSigninToken(token);
      if (result.userId === null) {
        // Token was unknown / expired / already consumed.
        res.status(401).json({ success: false, message: "Invalid or expired link" });
        return;
      }
      try {
        await req.createWebSession(result.userId);
      } catch (err) {
        getRequestLogger(req).error({ err }, "auth/bot-signin createWebSession failed");
        res.status(500).json({ success: false, message: "Failed to create session" });
        return;
      }
      res.json({
        success: true,
        redirectUrl: "/dashboard",
      });
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "auth/bot-signin failed");
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  // ── POST /api/v1/auth/check-username ────────────────────────────────────────
  // Non-mutating availability probe used by the register form for live
  // feedback. Deliberately NOT behind the register rate limiter (that
  // limiter exists to throttle real account creation, 3/h). This is a
  // read-only lookup, so it only carries the generic /api limiter.
  router.post("/auth/check-username", async (req: Request, res: Response) => {
    try {
      const username =
        typeof req.body?.username === "string" ? req.body.username : "";
      // Mirror the SPA's format rules; bail cheaply on obviously bad input.
      if (username.length < 3 || username.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
        res.json({ available: false });
        return;
      }
      if (!adminClient) {
        // Can't verify — don't block the user, let submit be the source of truth.
        res.json({ available: true });
        return;
      }
      const result = await adminClient.webAuth.checkLogin(username);
      res.json({ available: result.available });
    } catch (e: unknown) {
      getRequestLogger(req).warn({ err: e }, "auth/check-username failed");
      // Non-fatal: assume available and let the real submit decide.
      res.json({ available: true });
    }
  });

  // ── POST /api/v1/auth/register ──────────────────────────────────────────────
  router.post(
    "/auth/register",
    registerRateLimiter,
    requireMode('register', {
      hasInvite: (req): boolean => {
        const code = (req.body as { referralCode?: unknown } | undefined)?.referralCode;
        return typeof code === 'string' && code.trim().length > 0;
      },
    }),
    async (req: Request, res: Response) => {
    try {
      // Validate request body with Zod
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const { username, passwordHash, referralCode, utm } = parsed.data;

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      const ip = req.ip ?? req.socket.remoteAddress ?? null;
      const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
      const refererHeader = req.headers.referer ?? req.headers.referrer;
      const referer = typeof refererHeader === "string" ? refererHeader : null;

      // Proxy to Rezeis_Admin
      const result = await adminClient.webAuth.register(username, passwordHash, {
        ...(referralCode ? { referralCode } : {}),
        registrationSnapshot: {
          channel: "web",
          ip,
          userAgent,
          referer,
          utm: utm ?? null,
        },
      });

      // Create web session — isolated so a session-store failure after a
      // successful account creation isn't misclassified as an upstream
      // registration error (e.g. a spurious 409) by the catch below.
      try {
        await req.createWebSession(result.userId);
      } catch (err) {
        getRequestLogger(req).error({ err }, "auth/register createWebSession failed");
        res.status(500).json({ message: "Account created but session setup failed. Please sign in." });
        return;
      }

      res.json({
        success: true,
        redirectUrl: "/dashboard",
      });
    } catch (e: unknown) {
      const { status: upstreamStatus, message: errMsg } = describeUpstreamError(e);

      // Handle specific error responses from Rezeis_Admin
      if (isUpstreamStatus(e, 403)) {
        res.status(403).json({ message: "Registration is currently disabled" });
        return;
      }
      if (isUpstreamStatus(e, 409) || errMsg.toLowerCase().includes("username")) {
        res.status(409).json({ message: "Username is already taken" });
        return;
      }
      if (isUpstreamStatus(e, 503) || errMsg.includes("unavailable")) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      // A non-classified failure reaching here means rezeis-admin returned
      // something other than 403/409/503 (e.g. 401 from a mismatched internal
      // JWT secret, a network error when the admin container is unreachable,
      // or a 500 from a Prisma error on a DB that hasn't had migrations
      // applied). Log the upstream status alongside the message so operators
      // can tell these apart from the reiwa logs alone, instead of seeing an
      // opaque "Internal server error".
      getRequestLogger(req).error(
        { err: errMsg, upstreamStatus },
        "auth/register failed",
      );
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/auth/login ─────────────────────────────────────────────────
  router.post(
    "/auth/login",
    loginRateLimiter,
    requireMode('login'),
    bruteForceDetection,
    async (req: Request, res: Response) => {
      try {
        // Validate request body with Zod
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            message: "Validation failed",
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join("."),
              message: i.message,
            })),
          });
          return;
        }

        const { username, passwordHash } = parsed.data;

        if (!adminClient) {
          // Internal failure after credential validation attempt — treat as invalid credentials
          res.status(401).json({ message: "Invalid username or password" });
          return;
        }

        // Proxy to Rezeis_Admin
        let result: {
          userId: string;
          requiresPasswordChange: boolean;
          telegramLinked: boolean;
          emailVerified: boolean;
        };

        try {
          result = await adminClient.webAuth.login(username, passwordHash);
        } catch {
          // Authentication failure — generic error (no username/password distinction)
          // Deny authentication even if the error message fails to display
          res.status(401).json({ message: "Invalid username or password" });
          return;
        }

        // Create web session — activate suppression mechanisms during successful auth
        try {
          await req.createWebSession(result.userId);
        } catch {
          // Internal authentication failure after credential validation
          // Treat as invalid credentials and show generic error message
          res.status(401).json({ message: "Invalid username or password" });
          return;
        }

        // Determine redirect based on requiresPasswordChange
        // Suppression flags are activated: suppress error displays and password change
        // redirects during successful authentication flow
        const redirectUrl = result.requiresPasswordChange
          ? "/change-password"
          : "/dashboard";

        res.json({
          success: true,
          redirectUrl,
          requiresPasswordChange: result.requiresPasswordChange,
          suppressErrors: true,
          suppressPasswordChangeRedirect: true,
        });
      } catch (e: unknown) {
        getRequestLogger(req).error({ err: e }, "auth/login failed");
        // Any unexpected error — deny authentication with generic message
        res.status(401).json({ message: "Invalid username or password" });
      }
    },
  );

  // ── POST /api/v1/auth/logout ────────────────────────────────────────────────
  router.post("/auth/logout", async (req: Request, res: Response) => {
    try {
      // Destroy server-side session and clear session cookie
      // This also supports session destruction through inactivity timeouts,
      // administrative actions, and other system-initiated mechanisms
      // (those are handled by the WebSessionStore TTL and admin endpoints)
      await req.destroyWebSession();

      // Also destroy the legacy session if present
      const legacySessionId = req.cookies?.reiwa_session as string | undefined;
      if (legacySessionId && sessionStore) {
        await sessionStore.destroy(legacySessionId);
        res.clearCookie("reiwa_session");
      }

      res.json({ success: true });
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "auth/logout failed");
      // Even on error, clear cookies client-side
      res.clearCookie("reiwa_web_session", { path: "/" });
      res.clearCookie("reiwa_session");
      res.json({ success: true });
    }
  });

  // ── POST /api/v1/auth/recover ───────────────────────────────────────────────
  router.post(
    "/auth/recover",
    recoverRateLimiter,
    bruteForceDetection,
    async (req: Request, res: Response) => {
      try {
        // Validate request body with Zod
        const parsed = recoverSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            message: "Validation failed",
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join("."),
              message: i.message,
            })),
          });
          return;
        }

        const { username } = parsed.data;

        if (!adminClient) {
          res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
          return;
        }

        // Proxy to Rezeis_Admin
        const result = await adminClient.webAuth.recover(username);

        res.json({
          method: result.method,
          message: getRecoveryMessage(result.method),
        });
      } catch (e: unknown) {
        getRequestLogger(req).error({ err: e }, "auth/recover failed");
        // Anti-enumeration: return a generic response even on error
        res.json({
          method: "none" as const,
          message: "If an account with that username exists, recovery instructions have been sent.",
        });
      }
    },
  );

  // ── GET /api/v1/auth/status ─────────────────────────────────────────────────
  router.get("/auth/status", async (req: Request, res: Response) => {
    try {
      // Check registration toggle state
      let isRegistrationEnabled = false;
      if (adminClient) {
        try {
          const toggleResult = await adminClient.system.getRegistrationToggle();
          isRegistrationEnabled = toggleResult.enabled;
        } catch {
          // If we can't fetch toggle state, default to disabled
          isRegistrationEnabled = false;
        }
      }

      // Validate server-side session exists
      const hasSessionCookie = !!req.webSessionId;
      const hasServerSession = !!req.webSession;

      // Session validation logic per requirements:
      // - If server-side session is missing while cookie remains → already handled by
      //   web session middleware (clears stale cookie). After middleware runs,
      //   webSession will be null and webSessionId will be null.
      // - If session cookie is missing regardless of server-side session state → deny access
      // - If both are absent → deny access
      // - If 'active session' flag detected while both cookie and server-side session
      //   are absent → treat flag as invalid and deny access

      const isAuthenticated = hasSessionCookie && hasServerSession;

      // Context from context detection middleware
      const context = req.context ?? "web";

      res.json({
        isRegistrationEnabled,
        isAuthenticated,
        context,
      });
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "auth/status failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/auth/change-password ───────────────────────────────────────
  router.post("/auth/change-password", async (req: Request, res: Response) => {
    try {
      // Must be authenticated
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      // Validate request body with Zod
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const { currentPasswordHash, newPasswordHash } = parsed.data;

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      // Proxy to Rezeis_Admin
      const userId = req.webSession.userId;
      const result = await adminClient.webAuth.changePassword(
        userId,
        currentPasswordHash,
        newPasswordHash,
      );

      res.json({
        success: result.success,
        redirectUrl: "/dashboard",
      });
    } catch (e: unknown) {
      const { message: errMsg } = describeUpstreamError(e);

      if (isUpstreamStatus(e, 401) || errMsg.toLowerCase().includes("password")) {
        res.status(401).json({ message: "Current password is incorrect" });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "auth/change-password failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/auth/claim ─────────────────────────────────────────────────
  //
  // Mandatory first-entry onboarding: an authenticated Telegram-first user
  // (resolved into a WebSession by `/auth/telegram/bootstrap`) sets a login +
  // password so they can reach their account from a browser without Telegram.
  // The userId is taken from the server-side WebSession — NEVER from the body —
  // so a caller can only ever attach credentials to their own account.
  router.post("/auth/claim", async (req: Request, res: Response) => {
    try {
      // Must be authenticated (WebSession from Mini App bootstrap / login).
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const { username, passwordHash } = parsed.data;

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      const userId = req.webSession.userId;
      const result = await adminClient.webAuth.claim(userId, username, passwordHash);

      res.json({
        success: true,
        userId: result.userId,
        redirectUrl: "/dashboard",
      });
    } catch (e: unknown) {
      const { status: upstreamStatus, message: errMsg } = describeUpstreamError(e);

      // Login taken / user already claimed → 409, recoverable on /claim.
      if (isUpstreamStatus(e, 409) || errMsg.toLowerCase().includes("taken")) {
        res.status(409).json({ message: "Username is already taken" });
        return;
      }
      // Policy-violating login/password → 400, recoverable on /claim.
      if (isUpstreamStatus(e, 400)) {
        res.status(400).json({ message: "Invalid login or password format" });
        return;
      }
      // Fail-closed on everything else: keep the gate shut.
      getRequestLogger(req).error({ err: errMsg, upstreamStatus }, "auth/claim failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/auth/telegram/bootstrap ────────────────────────────────────
  //
  // Telegram Mini App entry. The SPA (`/tma`) sends the signed
  // `Telegram.WebApp.initData` here; we validate it (HMAC-SHA256 keyed by the
  // bot token), ensure the User exists in rezeis-admin, then mint a real
  // **WebSession** — the SAME session model used by web login / register /
  // magic-link. This is critical: the cabinet guards authenticate against the
  // WebSession (`reiwa_web_session` cookie / `req.webSession.userId`), so a
  // Mini App user must get a WebSession, not the legacy `reiwa_session`,
  // otherwise the dashboard bounces them back to the web login form.
  //
  // We reuse the proven bot-signin machinery to turn a telegramId into the
  // canonical reiwa_id: issue a one-time token → consume it → `userId`. This
  // also resolves an EXISTING user (e.g. imported from Remnawave with a
  // subscription), so the Mini App lands on their real subscription instead
  // of creating a duplicate.
  router.post("/auth/telegram/bootstrap", authLimiter, async (req, res) => {
    try {
      const initData = (req.headers.authorization ?? "").replace(
        /^tma\s+/i,
        "",
      );
      if (!initData || !config.BOT_TOKEN) {
        // Public wording stays neutral; token misconfig is operator-only (logs).
        getRequestLogger(req).error(
          { hasInitData: Boolean(initData), hasBotToken: Boolean(config.BOT_TOKEN) },
          "auth/telegram/bootstrap: missing initData or BOT_TOKEN",
        );
        res.status(400).json({ message: "Authentication unavailable" });
        return;
      }
      const tgUser = validateTelegramInitData(initData, config.BOT_TOKEN);
      if (!tgUser) {
        // Diagnostic: distinguish a hash mismatch (token/data problem) from a
        // stale auth_date (clock skew / reused initData). This unsigned parser
        // is used only for server logs — never trust it for BOT_DEV_ID gating
        // (an attacker can forge user.id without a valid hash).
        const parsed = parseUnverifiedTelegramInitData(initData);
        const ageSeconds =
          parsed !== null ? Math.floor(Date.now() / 1000) - parsed.auth_date : null;
        const diag = diagnoseTelegramInitData(initData, config.BOT_TOKEN);
        getRequestLogger(req).warn(
          {
            initDataLen: initData.length,
            parsed: parsed !== null,
            ageSeconds,
            keys: diag.keys,
            hasSignature: diag.hasSignature,
            computedPrefix: diag.computedPrefix,
            providedPrefix: diag.providedPrefix,
          },
          "auth/telegram/bootstrap: initData validation failed",
        );
        res.status(401).json({ message: "Authentication failed" });
        return;
      }
      if (!adminClient) {
        res.status(503).json({ message: "Service not configured" });
        return;
      }

      const telegramId = String(tgUser.id);

      // 1. Ensure the User row exists in rezeis-admin (idempotent).
      await adminClient.user.bootstrap({
        telegramId,
        username: tgUser.username,
        name: `${tgUser.first_name}${tgUser.last_name ? " " + tgUser.last_name : ""}`,
        language: tgUser.language_code?.toUpperCase() ?? "EN",
      });

      // 2. Resolve telegramId → canonical reiwa_id via the magic-link tokens.
      //    `token === null` means the user is blocked / unresolvable.
      const issued = await adminClient.webAuth.issueBotSigninToken(telegramId);
      if (issued.token === null) {
        getRequestLogger(req).warn(
          { telegramId },
          "auth/telegram/bootstrap: signin token issue returned null (blocked/unresolvable)",
        );
        res.status(403).json(
          bootstrapClientError({
            message: "Access denied",
            telegramId,
            config,
            debug: "issueBotSigninToken returned null (user missing or isBlocked)",
          }),
        );
        return;
      }
      const consumed = await adminClient.webAuth.consumeBotSigninToken(issued.token);
      if (consumed.userId === null) {
        getRequestLogger(req).warn(
          { telegramId },
          "auth/telegram/bootstrap: signin token consume returned null",
        );
        res.status(401).json(
          bootstrapClientError({
            message: "Authentication failed",
            telegramId,
            config,
            debug: "consumeBotSigninToken returned null (expired/already used)",
          }),
        );
        return;
      }

      // 3. Mint the WebSession (sets the `reiwa_web_session` cookie).
      try {
        await req.createWebSession(consumed.userId);
      } catch (err) {
        getRequestLogger(req).error({ err }, "auth/telegram/bootstrap createWebSession failed");
        res.status(500).json(
          bootstrapClientError({
            message: "Session setup failed",
            telegramId,
            config,
            debug: "createWebSession threw — check Redis / cookie config",
          }),
        );
        return;
      }

      res.json({ ok: true, redirectUrl: "/dashboard" });
    } catch (e: unknown) {
      // Best-effort identity for dev-only diagnostics when validation already
      // succeeded before the throw, or when we can still parse initData.
      const initData = (req.headers.authorization ?? "").replace(/^tma\s+/i, "");
      const maybeUser =
        initData && config.BOT_TOKEN
          ? validateTelegramInitData(initData, config.BOT_TOKEN)
          : null;
      const telegramId = maybeUser ? String(maybeUser.id) : null;

      // Access-mode gate on brand-new Telegram users (REG_BLOCKED / INVITED
      // without invite) returns 403 from rezeis-admin. Product codes are
      // public; raw upstream dumps go only to BOT_DEV_ID via `debug`.
      if (isUpstreamStatus(e, 403)) {
        const { message: body } = describeUpstreamError(e);
        let code: string | undefined;
        let message = "Access denied";
        try {
          const parsed = JSON.parse(body) as {
            code?: string;
            message?: string;
            // Nest often wraps as { statusCode, message: { code, message } }
            // or { message: string | string[] }.
          };
          const nested =
            parsed && typeof parsed === "object" && "message" in parsed
              ? parsed.message
              : null;
          if (nested && typeof nested === "object" && !Array.isArray(nested)) {
            const n = nested as { code?: string; message?: string };
            code = n.code ?? parsed.code;
            message = n.message ?? parsed.message ?? message;
          } else if (typeof nested === "string") {
            code = parsed.code;
            message = nested;
          } else if (typeof parsed.message === "string") {
            code = parsed.code;
            message = parsed.message;
          } else if (parsed.code) {
            code = parsed.code;
          }
        } catch {
          // body wasn't JSON — keep defaults
        }
        getRequestLogger(req).warn(
          { err: body, code, telegramId },
          "auth/telegram/bootstrap: upstream forbidden",
        );
        const productCodes = new Set([
          "REGISTRATION_DISABLED",
          "INVITE_REQUIRED",
          "SERVICE_RESTRICTED",
        ]);
        // Product gates: everyone sees the stable code + message.
        // Misc 403: public message only; debug only for BOT_DEV_ID.
        if (code && productCodes.has(code)) {
          res.status(403).json({ code, message });
          return;
        }
        res.status(403).json(
          bootstrapClientError({
            code,
            message: "Access denied",
            telegramId,
            config,
            debug: `upstream 403: ${body.slice(0, 500)}`,
          }),
        );
        return;
      }
      if (isUpstreamStatus(e, 503)) {
        res.status(503).json({
          code: "SERVICE_RESTRICTED",
          message: "Service is temporarily unavailable",
        });
        return;
      }
      getRequestLogger(req).error({ err: e, telegramId }, "auth/telegram/bootstrap failed");
      res.status(500).json(
        bootstrapClientError({
          message: "Internal server error",
          telegramId,
          config,
          debug: describeUpstreamError(e).message.slice(0, 500),
        }),
      );
    }
  });

  // ── POST /api/v1/auth/telegram/link-existing ────────────────────────────────
  //
  // Mini App "I already have an account" flow. The user proves control of the
  // Telegram id via signed `initData` (Authorization: tma <initData>) AND
  // ownership of their existing web account via login + password. rezeis binds
  // the Telegram id to that account when safe (free / same / empty shell); we
  // then re-mint the WebSession as the existing account so the subscription
  // shows up and bot→Mini App auto-login lands there. Typed refusals
  // (needs_admin_merge / other-telegram) map to 409 for the SPA to explain.
  router.post("/auth/telegram/link-existing", authLimiter, async (req: AuthRequest, res) => {
    try {
      const initData = (req.headers.authorization ?? "").replace(/^tma\s+/i, "");
      if (!initData || !config.BOT_TOKEN) {
        res.status(400).json({ message: "Missing init data or bot token not configured" });
        return;
      }
      const tgUser = validateTelegramInitData(initData, config.BOT_TOKEN);
      if (!tgUser) {
        res.status(401).json({ message: "Invalid Telegram init data" });
        return;
      }
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        });
        return;
      }
      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      const telegramId = String(tgUser.id);
      const result = await adminClient.webAuth.telegramClaim(
        telegramId,
        parsed.data.username,
        parsed.data.passwordHash,
      );

      if (result.status === "needs_admin_merge") {
        res.status(409).json({
          code: "NEEDS_ADMIN_MERGE",
          message: "This Telegram account already has its own history. Please contact support to merge accounts.",
        });
        return;
      }
      if (result.status === "web_account_has_other_telegram") {
        res.status(409).json({
          code: "WEB_ACCOUNT_HAS_OTHER_TELEGRAM",
          message: "This account is already linked to a different Telegram account.",
        });
        return;
      }
      if (!result.userId) {
        getRequestLogger(req).error({ status: result.status }, "auth/telegram/link-existing: linked status without userId");
        res.status(500).json({ message: "Internal server error" });
        return;
      }

      // Re-mint the WebSession as the existing account (replaces any session
      // the user held as the empty Telegram shell).
      try {
        await req.destroyWebSession?.();
      } catch {
        /* best-effort: a stale session is overwritten by createWebSession below */
      }
      await req.createWebSession(result.userId);
      res.json({ ok: true, status: result.status, redirectUrl: "/dashboard" });
    } catch (e: unknown) {
      // Invalid credentials (or a policy-violating login) come back as upstream
      // 401/400 — collapse both to a generic failure (no account enumeration).
      if (isUpstreamStatus(e, 401) || isUpstreamStatus(e, 400)) {
        res.status(401).json({ message: "Invalid login or password" });
        return;
      }
      const { status: upstreamStatus, message: errMsg } = describeUpstreamError(e);
      getRequestLogger(req).error({ err: errMsg, upstreamStatus }, "auth/telegram/link-existing failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Legacy: POST /api/v1/auth/sign-out ──────────────────────────────────────
  router.post(
    "/auth/sign-out",
    requireSession,
    async (req: AuthRequest, res) => {
      const sessionId = req.cookies?.reiwa_session as string | undefined;
      if (sessionId && sessionStore) await sessionStore.destroy(sessionId);
      res.clearCookie("reiwa_session");
      res.json({ ok: true });
    },
  );

  // ── External auth (web-cabinet social sign-in / registration) ───────────────
  //
  // OAuth providers (Google/Yandex/Mail.ru): the browser hits `/start`, we set a
  // CSRF `state` + PKCE verifier cookie and 302 to the provider; the provider
  // redirects back to `/callback`, we validate state and forward the code to
  // rezeis (which holds the secret) to resolve the account decision. Telegram
  // is verified HERE (we hold the bot token) then resolved upstream. A new
  // sign-up mints a session and lands on `/finish-setup` (login + password stay
  // mandatory); an existing identity lands on `/dashboard`.
  const extRedirectUri = (req: Request, provider: string): string => {
    const fwd = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
    const proto = fwd && fwd.length > 0 ? fwd : req.protocol;
    return `${proto}://${req.get("host")}/api/v1/auth/ext/${provider}/callback`;
  };
  const toUpperOAuthProvider = (p: string): "GOOGLE" | "YANDEX" | "MAILRU" | null => {
    if (p === "google") return "GOOGLE";
    if (p === "yandex") return "YANDEX";
    if (p === "mailru") return "MAILRU";
    return null;
  };
  // Superset that also maps Telegram — used for the OIDC redirect flow
  // (oauth.telegram.org) which, unlike the widget, goes through /start + code.
  const toExtProvider = (
    p: string,
  ): "GOOGLE" | "YANDEX" | "MAILRU" | "TELEGRAM" | null =>
    p === "telegram" ? "TELEGRAM" : toUpperOAuthProvider(p);
  const EXT_COOKIE_OPTS = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    maxAge: 600_000,
    path: "/api/v1/auth/ext",
  };

  router.get("/auth/ext/providers", async (req: Request, res: Response) => {
    if (!adminClient) {
      res.json({ providers: [] });
      return;
    }
    try {
      const providers = await adminClient.extAuth.listProviders();
      res.json({ providers });
    } catch (e: unknown) {
      getRequestLogger(req).warn({ err: describeUpstreamError(e).message }, "auth/ext/providers failed");
      res.json({ providers: [] });
    }
  });

  router.get("/auth/ext/:provider/start", loginRateLimiter, async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const upper = toExtProvider(provider);
    if (!upper || !adminClient) {
      res.redirect("/sign-in?error=ext_unavailable");
      return;
    }
    try {
      const state = randomBytes(16).toString("hex");
      const verifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
      res.cookie("ext_state", `${provider}:${state}`, EXT_COOKIE_OPTS);
      res.cookie("ext_verifier", verifier, EXT_COOKIE_OPTS);
      const { url } = await adminClient.extAuth.authorizeUrl({
        provider: upper,
        state,
        redirectUri: extRedirectUri(req, provider),
        codeChallenge,
      });
      res.redirect(url);
    } catch (e: unknown) {
      getRequestLogger(req).warn({ err: describeUpstreamError(e).message }, "auth/ext/start failed");
      res.redirect("/sign-in?error=ext_failed");
    }
  });

  router.get("/auth/ext/:provider/callback", loginRateLimiter, async (req: AuthRequest, res: Response) => {
    const provider = String(req.params.provider);
    if (!adminClient) {
      res.redirect("/sign-in?error=ext_unavailable");
      return;
    }
    try {
      let resolution;
      if (provider === "telegram" && typeof req.query.code !== "string") {
        // Classic Login Widget path (no OAuth `code`): the widget posts signed
        // fields we HMAC-verify here with the bot token.
        if (!config.BOT_TOKEN) {
          res.redirect("/sign-in?error=ext_unavailable");
          return;
        }
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.query)) {
          fields[k] = typeof v === "string" ? v : Array.isArray(v) ? String(v[0] ?? "") : "";
        }
        const tgUser = validateTelegramWidget(fields, config.BOT_TOKEN);
        if (!tgUser) {
          res.redirect("/sign-in?error=ext_failed");
          return;
        }
        const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || tgUser.username || null;
        resolution = await adminClient.extAuth.resolveTelegram({
          providerUserId: String(tgUser.id),
          ...(name ? { name } : {}),
        });
      } else {
        // OAuth2 / OIDC authorization-code path — used by Google/Yandex/Mail.ru
        // AND by Telegram when the operator enabled its OIDC mode.
        const upper = toExtProvider(provider);
        if (!upper) {
          res.redirect("/sign-in?error=ext_unavailable");
          return;
        }
        const code = typeof req.query.code === "string" ? req.query.code : null;
        const state = typeof req.query.state === "string" ? req.query.state : null;
        const storedState = req.cookies?.ext_state as string | undefined;
        const verifier = req.cookies?.ext_verifier as string | undefined;
        res.clearCookie("ext_state", { path: "/api/v1/auth/ext" });
        res.clearCookie("ext_verifier", { path: "/api/v1/auth/ext" });
        if (!code || !state || storedState !== `${provider}:${state}`) {
          res.redirect("/sign-in?error=ext_state");
          return;
        }
        resolution = await adminClient.extAuth.resolveOAuth({
          provider: upper,
          code,
          redirectUri: extRedirectUri(req, provider),
          ...(verifier ? { codeVerifier: verifier } : {}),
        });
      }

      if (resolution.action === "denied") {
        res.redirect("/sign-in?error=denied");
        return;
      }
      await req.createWebSession(resolution.userId);
      res.redirect(resolution.action === "finish_setup" ? "/finish-setup" : "/dashboard");
    } catch (e: unknown) {
      getRequestLogger(req).warn({ err: describeUpstreamError(e).message }, "auth/ext/callback failed");
      res.redirect("/sign-in?error=ext_failed");
    }
  });

  const extFinishSchema = z.object({
    username: z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(32, "Username must be at most 32 characters")
      .regex(/^[a-zA-Z0-9_-]+$/, "Username may only contain alphanumeric characters, hyphens, or underscores"),
    passwordHash: z
      .string()
      .length(64, "Password hash must be a 64-character SHA-256 hex string")
      .regex(/^[a-f0-9]+$/i, "Password hash must be a valid hex string"),
  });

  router.post("/auth/ext/finish-setup", loginRateLimiter, async (req: AuthRequest, res: Response) => {
    try {
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      const parsed = extFinishSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Validation failed" });
        return;
      }
      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }
      await adminClient.extAuth.finishSetup({
        userId: req.webSession.userId,
        login: parsed.data.username,
        passwordHash: parsed.data.passwordHash,
      });
      res.json({ success: true, redirectUrl: "/dashboard" });
    } catch (e: unknown) {
      const { message: errMsg } = describeUpstreamError(e);
      if (isUpstreamStatus(e, 409)) {
        res.status(409).json({ message: "This login is already taken" });
        return;
      }
      getRequestLogger(req).error({ err: errMsg }, "auth/ext/finish-setup failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  return router;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getRecoveryMessage(method: "telegram" | "email" | "none"): string {
  switch (method) {
    case "telegram":
      return "A password reset confirmation has been sent to your linked Telegram account.";
    case "email":
      return "Recovery instructions have been sent to your registered email address.";
    case "none":
      return "No recovery method is available for this account. Please contact support.";
  }
}
