import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

import { proxyStream } from "./realtime-proxy.js";

/**
 * SSE proxy from the user PWA / Mini App to the rezeis-admin
 * `/api/internal/user/:userRef/stream` endpoint.
 *
 * Auth model
 *   - The flexible session middleware authenticates the browser via
 *     either the WebSession (reiwa_id — web-first users with no Telegram)
 *     or the legacy Telegram session, then `resolveUserIdentity` yields
 *     the canonical id. The user can never request a stream for someone
 *     else — the reference comes from the server-side session.
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
 *
 * A stream outlives the request that opened it, and the session check
 * runs on requests: a stream opened before «Выйти на всех устройствах» or a
 * password change elsewhere kept delivering to a session that no longer
 * existed. The proxy now asks, at most once a minute, whether the session it
 * was opened with is still good (`sessionStillValid`), and ends the stream
 * when it is not: signed out here, ended by a check, expired, or signed out
 * elsewhere according to the panel.
 */
export function createRealtimeRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  router.get("/realtime/stream", requireSession, async (req: AuthRequest, res) => {
    const identity = resolveUserIdentity(req);
    const userRef = identity.userId ?? identity.telegramId;
    if (!userRef) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (!adminClient) {
      res.status(503).json({ message: "Realtime backend unavailable" });
      return;
    }
    await proxyStream(
      adminClient,
      userRef,
      res,
      (error) => {
        getRequestLogger(req).warn(
          { err: error },
          "Realtime upstream connection failed",
        );
      },
      { stillValid: () => sessionStillValid(req, sessionStore) },
    );
  });

  return router;
}

/**
 * Whether the session a stream was opened with is still good. A web session
 * is judged by the session middleware's own rules (`revalidateWebSession`:
 * gone, or signed out according to the panel, asked at most once a minute); a
 * Telegram session only by whether it still exists. With neither, the stream
 * was authorised by nothing that can end.
 */
async function sessionStillValid(req: AuthRequest, sessionStore: SessionStore | null): Promise<boolean> {
  if (req.webSessionId) return (await req.revalidateWebSession?.()) ?? true;
  const legacyId = req.cookies?.reiwa_session as string | undefined;
  if (legacyId && sessionStore) return (await sessionStore.get(legacyId)) !== null;
  return true;
}
