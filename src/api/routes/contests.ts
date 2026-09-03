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
 * Contests — events with a draw at the end — for the person entering them.
 *
 * Session-scoped like the wheel and the quests: the identity is resolved from
 * the reiwa session and forwarded as `:userRef`, so a person only ever reads
 * their own standing and enters as themselves.
 */
export function createContestsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/contests — running contests + this person's results.
  router.get("/contests", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.contests.list(resolveUserIdentity(req));
      res.json(result ?? []);
    } catch (err: unknown) {
      // Same reasoning as the wheel: a panel that predates contests answers
      // 404, this runs on every dashboard render, and "no contests" is a
      // truthful answer the screen already draws.
      if (isUpstreamStatus(err, 404)) {
        getRequestLogger(req).warn("GET /contests: panel does not have contests yet");
        res.json([]);
        return;
      }
      getRequestLogger(req).error({ err }, "GET /contests failed");
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/v1/contests/:contestId/enter — take part.
  router.post("/contests/:contestId/enter", requireSession, async (req: AuthRequest, res) => {
    const contestId = String(req.params.contestId);
    try {
      const result = await adminClient?.contests.enter(resolveUserIdentity(req), contestId);
      res.json(result ?? { entered: false, reason: "NOT_OPEN" });
    } catch (err: unknown) {
      getRequestLogger(req).warn({ err, contestId }, "POST /contests/:contestId/enter failed");
      const status = isUpstreamStatus(err, 404) ? 404 : isUpstreamStatus(err, 400) ? 400 : 500;
      res.status(status).json({ error: status === 500 ? "internal" : "entry_rejected" });
    }
  });

  return router;
}
