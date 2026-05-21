import { Router } from "express";
import type { Response } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

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

async function proxyStream(
  adminClient: AdminClient,
  telegramId: string,
  res: Response,
): Promise<void> {
  // Pre-set SSE headers on the browser side so the connection upgrades
  // cleanly even if the upstream open is slow.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const upstream = await adminClient.openStream(
    `/api/internal/user/${encodeURIComponent(telegramId)}/stream`,
  );
  if (!upstream) {
    res.write(`event: realtime.unavailable\n`);
    res.write(`data: {"reason":"upstream_rejected"}\n\n`);
    res.end();
    return;
  }

  // Copy bytes upstream → browser as-is. SSE frames are simple
  // line-oriented chunks; we don't need to inspect them.
  const stream = upstream.body;

  const cleanup = (): void => {
    try {
      // `stream` is an undici Readable that supports `.destroy()`.
      (stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.();
    } catch {
      /* ignore */
    }
  };

  stream.on("data", (chunk: Buffer) => {
    if (res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  });
  stream.on("end", () => {
    if (!res.writableEnded) res.end();
  });
  stream.on("error", () => {
    if (!res.writableEnded) res.end();
  });

  // Browser disconnected — close upstream so we stop pulling bytes.
  req(res).on?.("close", cleanup);
}

/**
 * Express's typings don't expose the `req` instance on the `Response`
 * directly in the version we use. This helper is a tiny shim that
 * returns the request object so we can listen for `close` events.
 */
function req(res: Response): { on?: (event: string, handler: () => void) => void } {
  return res.req as unknown as {
    on?: (event: string, handler: () => void) => void;
  };
}
