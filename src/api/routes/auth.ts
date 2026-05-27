import { Router, Request, Response } from "express";
import { z } from "zod";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { validateTelegramInitData } from "../../lib/telegram-auth.js";
import { authLimiter, createRedisRateLimiter } from "../middleware/rate-limit.js";
import { createSessionMiddleware } from "../middleware/session.js";
import { createAuthBruteForceDetection } from "../middleware/brute-force-detection.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
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

  // ── POST /api/v1/auth/register ──────────────────────────────────────────────
  router.post("/auth/register", registerRateLimiter, async (req: Request, res: Response) => {
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

      const { username, passwordHash } = parsed.data;

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      // Proxy to Rezeis_Admin
      const result = await adminClient.webAuth.register(username, passwordHash);

      // Create web session
      await req.createWebSession(result.userId);

      res.json({
        success: true,
        redirectUrl: "/dashboard",
      });
    } catch (e: unknown) {
      const errMsg = (e as Error).message ?? "";

      // Handle specific error responses from Rezeis_Admin
      if (errMsg.includes("403")) {
        res.status(403).json({ message: "Registration is currently disabled" });
        return;
      }
      if (errMsg.includes("409") || errMsg.toLowerCase().includes("username")) {
        res.status(409).json({ message: "Username is already taken" });
        return;
      }
      if (errMsg.includes("503") || errMsg.includes("unavailable")) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "auth/register failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/auth/login ─────────────────────────────────────────────────
  router.post(
    "/auth/login",
    loginRateLimiter,
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
      const errMsg = (e as Error).message ?? "";

      if (errMsg.includes("401") || errMsg.toLowerCase().includes("password")) {
        res.status(401).json({ message: "Current password is incorrect" });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "auth/change-password failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Legacy: POST /api/v1/auth/telegram/bootstrap ────────────────────────────
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
        res.status(401).json({ message: "Invalid Telegram init data" });
        return;
      }
      if (!adminClient || !sessionStore) {
        res.status(503).json({ message: "Service not configured" });
        return;
      }
      const user = (await adminClient.user.bootstrap({
        telegramId: String(tgUser.id),
        username: tgUser.username,
        name: `${tgUser.first_name}${tgUser.last_name ? " " + tgUser.last_name : ""}`,
        language: tgUser.language_code?.toUpperCase() ?? "EN",
      })) as Record<string, unknown>;

      const sessionId = await sessionStore.create({
        telegramId: String(tgUser.id),
        userId: (user["id"] as number) ?? 0,
        name: (user["name"] as string) ?? tgUser.first_name,
        username: tgUser.username,
        role: (user["role"] as string) ?? "USER",
      });
      res.cookie("reiwa_session", sessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.REIWA_COOKIE_SECURE || config.NODE_ENV === "production",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.json({ ok: true, user });
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
