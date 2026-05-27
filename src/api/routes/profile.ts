import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

export function createProfileRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/session
  router.get("/session", requireSession, async (req: AuthRequest, res) => {
    try {
      const session = await adminClient?.user.getSession(req.telegramId!);
      res.json(session ?? req.session);
    } catch {
      res.json(req.session);
    }
  });

  // PATCH /api/v1/session/rules-acceptance
  router.patch(
    "/session/rules-acceptance",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.user.acceptRules(req.telegramId!);
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // GET /api/v1/platform-policy
  router.get("/platform-policy", async (_req, res) => {
    try {
      const policy = await adminClient?.system.getPlatformPolicy();
      res.json(policy ?? {});
    } catch {
      res.json({});
    }
  });

  // GET /api/v1/me — full profile (same data as /session)
  router.get("/me", requireSession, async (req: AuthRequest, res) => {
    try {
      const session = await adminClient?.user.getSession(req.telegramId!);
      res.json(session ?? req.session);
    } catch {
      res.json(req.session);
    }
  });

  // PATCH /api/v1/me/password
  router.patch(
    "/me/password",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { newPasswordHash } = (req.body ?? {}) as Record<string, unknown>;
        if (!newPasswordHash) {
          res.status(400).json({ message: "newPasswordHash is required" });
          return;
        }
        const result = await adminClient?.user.changeWebAccountPassword(
          req.telegramId!,
          String(newPasswordHash),
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // POST /api/v1/me/email/challenge — send email OTP
  router.post(
    "/me/email/challenge",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { email } = (req.body ?? {}) as Record<string, unknown>;
        if (!email) {
          res.status(400).json({ message: "email is required" });
          return;
        }
        await adminClient?.user.issueEmailVerificationChallenge(
          req.telegramId!,
          String(email),
        );
        res.status(204).end();
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // PATCH /api/v1/me/email/verify — complete email verification
  router.patch(
    "/me/email/verify",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { code } = (req.body ?? {}) as Record<string, unknown>;
        if (!code) {
          res.status(400).json({ message: "code is required" });
          return;
        }
        const result = await adminClient?.user.completeEmailVerification(
          req.telegramId!,
          String(code),
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(401).json({ message: (e as Error).message });
      }
    },
  );

  // PATCH /api/v1/me/link-prompt-snooze
  router.patch(
    "/me/link-prompt-snooze",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.user.snoozeWebAccountLinkPrompt(
          req.telegramId!,
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // GET /api/v1/config — public bot/app config
  router.get("/config", async (_req, res) => {
    try {
      const botConfig = await adminClient?.branding.getPublicConfig();
      res.json(botConfig ?? {});
    } catch {
      res.json({});
    }
  });

  // PATCH /api/v1/me/language — update user language
  router.patch(
    "/me/language",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { language } = (req.body ?? {}) as Record<string, unknown>;
        if (!language) {
          res.status(400).json({ message: "language is required" });
          return;
        }
        const result = await adminClient?.user.updateLanguage(
          req.telegramId!,
          String(language),
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  return router;
}
