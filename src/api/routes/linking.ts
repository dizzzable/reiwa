import { Router, Request, Response } from "express";
import { z } from "zod";
import type { AdminClient } from "../../lib/admin-client.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { describeUpstreamError, isUpstreamStatus } from "../lib/upstream-error.js";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

const emailInitiateSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required")
    .max(254, "Email exceeds maximum length")
    .email("Invalid email format"),
});

const emailVerifySchema = z.object({
  code: z
    .string()
    .length(6, "Verification code must be exactly 6 digits")
    .regex(/^\d{6}$/, "Verification code must be 6 digits"),
});

// ── Router Factory ──────────────────────────────────────────────────────────

export function createLinkingRouter(deps: {
  adminClient: AdminClient | null;
  webSessionStore: WebSessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, config } = deps;
  const router = Router();

  // ── POST /api/v1/link/telegram/initiate ─────────────────────────────────────
  router.post("/link/telegram/initiate", async (req: Request, res: Response) => {
    try {
      // Require authentication
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      const userId = req.webSession.userId;

      // Generate linking code via Rezeis_Admin
      const result = await adminClient.linking.telegram.generate(userId);

      // Get bot username — bot-config first, then the reiwa `BOT_USERNAME` env
      // fallback so the "Open bot" deep-link button always works even when the
      // admin bot-config doesn't carry a username yet.
      let botUsername: string | null = null;
      try {
        const botConfig = (await adminClient.branding.getBotConfig()) as Record<string, unknown>;
        botUsername =
          (botConfig?.["telegramBotUsername"] as string) ??
          (botConfig?.["botUsername"] as string) ??
          null;
        if (botUsername) {
          botUsername = botUsername.replace(/^@/, "").trim();
        }
      } catch {
        // Bot config fetch failed — fall back to the env below.
      }
      if (!botUsername) {
        botUsername = config.BOT_USERNAME ? config.BOT_USERNAME.replace(/^@/, "").trim() : null;
      }

      res.json({
        code: result.code,
        expiresAt: result.expiresAt,
        botUsername: botUsername || null,
      });
    } catch (e: unknown) {
      const { message: errMsg } = describeUpstreamError(e);

      if (isUpstreamStatus(e, 409) || errMsg.toLowerCase().includes("already linked")) {
        res.status(409).json({ message: "Telegram account is already linked" });
        return;
      }
      if (isUpstreamStatus(e, 503) || errMsg.includes("unavailable")) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "link/telegram/initiate failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/link/email/initiate ────────────────────────────────────────
  router.post("/link/email/initiate", async (req: Request, res: Response) => {
    try {
      // Require authentication
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      // Validate request body with Zod
      const parsed = emailInitiateSchema.safeParse(req.body);
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

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      const userId = req.webSession.userId;
      const { email } = parsed.data;

      // Proxy to Rezeis_Admin
      const result = await adminClient.linking.email.initiate(userId, email);

      res.json({
        success: result.success,
        message: result.message,
      });
    } catch (e: unknown) {
      const { message: errMsg } = describeUpstreamError(e);

      if (isUpstreamStatus(e, 409) || errMsg.toLowerCase().includes("already linked")) {
        res.status(409).json({ message: "Email is already linked to another account" });
        return;
      }
      if (isUpstreamStatus(e, 503) || errMsg.includes("unavailable")) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "link/email/initiate failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/link/email/verify ──────────────────────────────────────────
  router.post("/link/email/verify", async (req: Request, res: Response) => {
    try {
      // Require authentication
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      // Validate request body with Zod
      const parsed = emailVerifySchema.safeParse(req.body);
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

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      const userId = req.webSession.userId;
      const { code } = parsed.data;

      // Proxy to Rezeis_Admin
      const result = await adminClient.linking.email.verify(userId, code);

      res.json({
        success: result.success,
        verified: result.verified,
      });
    } catch (e: unknown) {
      const { message: errMsg } = describeUpstreamError(e);

      if (isUpstreamStatus(e, 410) || errMsg.toLowerCase().includes("expired")) {
        res.status(410).json({ message: "Verification code has expired" });
        return;
      }
      if (isUpstreamStatus(e, 429) || errMsg.toLowerCase().includes("too many attempts")) {
        res.status(429).json({ message: "Too many incorrect attempts. Code has been invalidated." });
        return;
      }
      if (isUpstreamStatus(e, 400) || errMsg.toLowerCase().includes("invalid code")) {
        res.status(400).json({ message: "Invalid verification code" });
        return;
      }
      if (isUpstreamStatus(e, 503) || errMsg.includes("unavailable")) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "link/email/verify failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  return router;
}
