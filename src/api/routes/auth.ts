import { Router, Request, Response } from "express";
import { z } from "zod";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { diagnoseTelegramInitData, parseTelegramInitData, validateTelegramInitData } from "../../lib/telegram-auth.js";
import { requireMode } from "../middleware/access-mode.js";
import { authLimiter, createRedisRateLimiter } from "../middleware/rate-limit.js";
import { createSessionMiddleware } from "../middleware/session.js";
import { createAuthBruteForceDetection } from "../middleware/brute-force-detection.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { describeUpstreamError, isUpstreamStatus } from "../lib/upstream-error.js";
import type { AuthRequest } from "../middleware/session.js";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

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

      const { username, passwordHash, referralCode } = parsed.data;

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      // Proxy to Rezeis_Admin
      const result = await adminClient.webAuth.register(username, passwordHash, {
        ...(referralCode ? { referralCode } : {}),
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
        res
          .status(400)
          .json({ message: "Missing init data or bot token not configured" });
        return;
      }
      const tgUser = validateTelegramInitData(initData, config.BOT_TOKEN);
      if (!tgUser) {
        // Diagnostic: distinguish a hash mismatch (token/data problem) from a
        // stale auth_date (clock skew / reused initData). `parse` is unsigned,
        // it only reads fields so we can log the age.
        const parsed = parseTelegramInitData(initData);
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
        res.status(401).json({ message: "Invalid Telegram init data" });
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
        res.status(403).json({ message: "Access denied" });
        return;
      }
      const consumed = await adminClient.webAuth.consumeBotSigninToken(issued.token);
      if (consumed.userId === null) {
        getRequestLogger(req).warn(
          { telegramId },
          "auth/telegram/bootstrap: signin token consume returned null",
        );
        res.status(401).json({ message: "Authentication failed" });
        return;
      }

      // 3. Mint the WebSession (sets the `reiwa_web_session` cookie).
      try {
        await req.createWebSession(consumed.userId);
      } catch (err) {
        getRequestLogger(req).error({ err }, "auth/telegram/bootstrap createWebSession failed");
        res.status(500).json({ message: "Session setup failed" });
        return;
      }

      res.json({ ok: true, redirectUrl: "/dashboard" });
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "auth/telegram/bootstrap failed");
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
