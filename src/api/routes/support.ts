import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

export function createSupportRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  // Identity-agnostic auth: accepts the WebSession (reiwa_id) used by
  // browser / Mini-App / magic-link logins AND the legacy Telegram
  // session. The support surface is keyed by reiwa_id upstream so
  // web-first users (no Telegram) are not locked out — the previous
  // `requireSession` + `req.telegramId` guard 401'd every web-auth user.
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/support/tickets
  router.get("/support/tickets", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.support.list(resolveUserIdentity(req));
      res.json(result ?? []);
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "GET /support/tickets failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "internal" });
    }
  });

  // GET /api/v1/support/tickets/:id
  router.get("/support/tickets/:id", requireSession, async (req: AuthRequest, res) => {
    const ticketId = String(req.params.id);
    try {
      const result = await adminClient?.support.get(resolveUserIdentity(req), ticketId);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "internal";
      getRequestLogger(req).warn({ err, ticketId }, "GET /support/tickets/:id failed");
      res.status(message.includes("404") ? 404 : 500).json({ error: message });
    }
  });

  // POST /api/v1/support/tickets
  router.post("/support/tickets", requireSession, async (req: AuthRequest, res) => {
    const { subject, message } = (req.body ?? {}) as { subject?: string; message?: string };
    if (!subject?.trim() || !message?.trim()) {
      res.status(400).json({ error: "Subject and message are required" });
      return;
    }
    try {
      const result = await adminClient?.support.create(resolveUserIdentity(req), {
        subject,
        message,
      });
      res.json(result);
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "POST /support/tickets failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "internal" });
    }
  });

  // POST /api/v1/support/tickets/:id/reply
  router.post("/support/tickets/:id/reply", requireSession, async (req: AuthRequest, res) => {
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) {
      res.status(400).json({ error: "Content is required" });
      return;
    }
    const ticketId = String(req.params.id);
    try {
      const result = await adminClient?.support.reply(resolveUserIdentity(req), ticketId, content);
      res.json(result);
    } catch (err: unknown) {
      getRequestLogger(req).error({ err, ticketId }, "POST /support/tickets/:id/reply failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "internal" });
    }
  });

  return router;
}
