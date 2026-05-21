import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

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
    try {
      const result = await adminClient?.request("GET", `/api/internal/user/${req.telegramId}/tickets`);
      res.json(result ?? []);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/support/tickets/:id
  router.get("/support/tickets/:id", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.request("GET", `/api/internal/user/${req.telegramId}/tickets/${req.params.id}`);
      res.json(result);
    } catch (err: any) {
      res.status(err.message?.includes("404") ? 404 : 500).json({ error: err.message });
    }
  });

  // POST /api/v1/support/tickets
  router.post("/support/tickets", requireSession, async (req: AuthRequest, res) => {
    try {
      const { subject, message } = req.body as { subject: string; message: string };
      if (!subject?.trim() || !message?.trim()) {
        return res.status(400).json({ error: "Subject and message are required" });
      }
      const result = await adminClient?.request("POST", `/api/internal/user/${req.telegramId}/tickets`, { subject, message });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/support/tickets/:id/reply
  router.post("/support/tickets/:id/reply", requireSession, async (req: AuthRequest, res) => {
    try {
      const { content } = req.body as { content: string };
      if (!content?.trim()) {
        return res.status(400).json({ error: "Content is required" });
      }
      const result = await adminClient?.request("POST", `/api/internal/user/${req.telegramId}/tickets/${req.params.id}/reply`, { content });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
