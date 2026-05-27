import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

import { proxyStream } from "./realtime-proxy.js";

/**
 * SSE proxy from the user PWA / Mini App to the rezeis-admin
 * `/api/internal/user/:telegramId/stream` endpoint.
 *
 * Auth model
 *   - reiwa session middleware authenticates the browser and resolves
 *     `req.telegramId`. The user can never request a stream for someone
 *     else's Telegram id — the param comes from server-side session.
 *   - reiwa then opens a streaming GET against rezeis-admin using the
 *     internal API key + (optional) HMAC signature already configured
 *     for the rest of the AdminClient.
 *   - reiwa pipes the upstream response straight to the browser. No
 *     buffering, no parsing — server load stays predictable even when
 *     hundreds of users are connected.
 *
 * Why SSE (not WS)?
 *   - One-direction. The user never publishes events back through this
 *     channel.
 *   - Plays nicely with reiwa's existing Express + cookie-session stack.
 *   - Reconnection is automatic on the browser side via `EventSource`.
 *
 * Wave 8F: the bytes-through-pipe logic lives in `realtime-proxy.ts`
 * so it can be unit-tested without the full router stack.
 */
export function createRealtimeRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  router.get("/realtime/stream", requireSession, async (req: AuthRequest, res) => {
    const telegramId = req.telegramId;
    if (!telegramId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (!adminClient) {
      res.status(503).json({ message: "Realtime backend unavailable" });
      return;
    }
    await proxyStream(adminClient, telegramId, res);
  });

  return router;
}
