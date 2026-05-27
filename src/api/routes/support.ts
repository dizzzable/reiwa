import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

export function createSupportRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/support/tickets
  router.get("/support/tickets", requireSession, async (req: AuthRequest, res) => {
    if (!req.telegramId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const result = await adminClient?.support.list(req.telegramId);
      res.json(result ?? []);
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "GET /support/tickets failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "internal" });
    }
  });

  // GET /api/v1/support/tickets/:id
  router.get("/support/tickets/:id", requireSession, async (req: AuthRequest, res) => {
    if (!req.telegramId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ticketId = String(req.params.id);
    try {
      const result = await adminClient?.support.get(req.telegramId, ticketId);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "internal";
      getRequestLogger(req).warn({ err, ticketId }, "GET /support/tickets/:id failed");
      res.status(message.includes("404") ? 404 : 500).json({ error: message });
    }
  });

  // POST /api/v1/support/tickets
  router.post("/support/tickets", requireSession, async (req: AuthRequest, res) => {
    if (!req.telegramId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { subject, message } = (req.body ?? {}) as { subject?: string; message?: string };
    if (!subject?.trim() || !message?.trim()) {
      res.status(400).json({ error: "Subject and message are required" });
      return;
    }
    try {
      const result = await adminClient?.support.create(req.telegramId, { subject, message });
      res.json(result);
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "POST /support/tickets failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "internal" });
    }
  });

  // POST /api/v1/support/tickets/:id/reply
  router.post("/support/tickets/:id/reply", requireSession, async (req: AuthRequest, res) => {
    if (!req.telegramId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) {
      res.status(400).json({ error: "Content is required" });
      return;
    }
    const ticketId = String(req.params.id);
    try {
      const result = await adminClient?.support.reply(req.telegramId, ticketId, content);
      res.json(result);
    } catch (err: unknown) {
      getRequestLogger(req).error({ err, ticketId }, "POST /support/tickets/:id/reply failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "internal" });
    }
  });

  return router;
}
