import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { isUpstreamStatus } from "../lib/upstream-error.js";

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
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/v1/support/tickets/:id
  router.get("/support/tickets/:id", requireSession, async (req: AuthRequest, res) => {
    const ticketId = String(req.params.id);
    try {
      const result = await adminClient?.support.get(resolveUserIdentity(req), ticketId);
      res.json(result);
    } catch (err: unknown) {
      getRequestLogger(req).warn({ err, ticketId }, "GET /support/tickets/:id failed");
      const notFound = isUpstreamStatus(err, 404);
      res.status(notFound ? 404 : 500).json({ error: notFound ? "not_found" : "internal" });
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
      res.status(500).json({ error: "internal" });
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
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/v1/support/tickets/:id/attachments/:attachmentId — stream a file
  // attached to one of the user's OWN tickets (e.g. an operator reply's photo).
  // Upstream scopes the fetch to the resolved user, so ownership is enforced
  // server-side; we proxy the binary straight through without buffering.
  router.get(
    "/support/tickets/:id/attachments/:attachmentId",
    requireSession,
    async (req: AuthRequest, res) => {
      const ticketId = String(req.params.id);
      const attachmentId = String(req.params.attachmentId);
      try {
        const file = await adminClient?.support.downloadAttachment(
          resolveUserIdentity(req),
          ticketId,
          attachmentId,
        );
        if (!file) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (file.contentType) res.setHeader("Content-Type", file.contentType);
        if (file.contentLength !== null) {
          res.setHeader("Content-Length", String(file.contentLength));
        }
        res.setHeader("Cache-Control", "private, no-store");
        file.body.pipe(res);
      } catch (err: unknown) {
        getRequestLogger(req).warn(
          { err, ticketId },
          "GET /support/tickets/:id/attachments/:attachmentId failed",
        );
        res.status(500).json({ error: "internal" });
      }
    },
  );

  // POST /api/v1/support/guest/attach — explicitly claim the anonymous
  // conversation in this browser for the logged-in account. Requires BOTH a
  // session (the account) and the httpOnly guest cookie (the conversation);
  // ownership transfer is never implicit.
  router.post("/support/guest/attach", requireSession, async (req: AuthRequest, res) => {
    const token = req.cookies?.["reiwa_support"] as string | undefined;
    if (typeof token !== "string" || token.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const identity = resolveUserIdentity(req);
    const ref = identity.userId ?? identity.telegramId ?? null;
    if (!ref) {
      res.status(400).json({ error: "no_identity" });
      return;
    }
    try {
      await adminClient?.support.attachGuest(token, ref);
      // The conversation is now account-owned; the guest cookie is inert.
      res.clearCookie("reiwa_support", { path: "/" });
      res.json({ ok: true });
    } catch (err: unknown) {
      const notFound = isUpstreamStatus(err, 404);
      if (notFound) res.clearCookie("reiwa_support", { path: "/" });
      getRequestLogger(req).warn({ err }, "POST /support/guest/attach failed");
      res.status(notFound ? 404 : 500).json({ error: notFound ? "not_found" : "internal" });
    }
  });

  return router;
}
