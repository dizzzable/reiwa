import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { isUpstreamStatus } from "../lib/upstream-error.js";

/**
 * Cabinet gamification (quests) surface. Session-scoped: the caller's identity
 * is resolved from the reiwa session and forwarded as `:userRef` upstream, so a
 * user only ever lists / claims their own quests. Icon serving is a plain
 * same-origin proxy of the sanitized SVG (session cookie sent by `<img>`).
 */
export function createQuestsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/quests — quests relevant to the user + points balance.
  router.get("/quests", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.quests.list(resolveUserIdentity(req));
      res.json(result ?? { pointsBalance: 0, quests: [] });
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "GET /quests failed");
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/v1/quests/:questId/claim — claim a completed quest's reward.
  router.post("/quests/:questId/claim", requireSession, async (req: AuthRequest, res) => {
    const questId = String(req.params.questId);
    try {
      const result = await adminClient?.quests.claim(resolveUserIdentity(req), questId);
      res.json(result ?? {});
    } catch (err: unknown) {
      getRequestLogger(req).warn({ err, questId }, "POST /quests/:questId/claim failed");
      const status = isUpstreamStatus(err, 400)
        ? 400
        : isUpstreamStatus(err, 404)
          ? 404
          : 500;
      res.status(status).json({ error: status === 500 ? "internal" : "claim_rejected" });
    }
  });

  // GET /api/v1/quests/icons/:iconId — stream a sanitized quest icon SVG.
  router.get("/quests/icons/:iconId", requireSession, async (req: AuthRequest, res) => {
    const iconId = String(req.params.iconId);
    try {
      const file = await adminClient?.quests.downloadIcon(iconId);
      if (!file) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (file.contentType) res.setHeader("Content-Type", file.contentType);
      if (file.contentLength !== null) {
        res.setHeader("Content-Length", String(file.contentLength));
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader("Cache-Control", "public, max-age=86400");
      // Guard against an unhandled 'error' event if the upstream stream drops
      // mid-transfer (would otherwise crash the process). try/catch does not
      // cover async stream errors emitted after the promise resolves.
      file.body.on("error", (streamErr: unknown) => {
        getRequestLogger(req).warn({ err: streamErr, iconId }, "quest icon stream error");
        if (!res.headersSent) res.status(502).json({ error: "upstream_stream" });
        else res.destroy();
      });
      file.body.pipe(res);
    } catch (err: unknown) {
      getRequestLogger(req).warn({ err, iconId }, "GET /quests/icons/:iconId failed");
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
}
