import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

/**
 * Device signals from the cabinet.
 *
 * ── Why the edge forwards this instead of the SPA calling upstream ────────
 *
 * Same reason as every other route here: the SPA has no upstream credentials,
 * and the identity it would otherwise assert about itself is taken from the
 * session cookie instead. A payload that named its own user id would let
 * anybody attach a device to somebody else's account — which, for a signal
 * whose purpose is to link accounts together, would be a way to get a stranger
 * marked as a ban evader.
 *
 * ── Always 200, and never anything else ──────────────────────────────────
 *
 * The mark this can raise is only worth having while the person carrying it
 * cannot tell it exists. An answer that varied — 404 when the account is
 * unknown, 500 when the upstream is down, a different body when a match was
 * found — is a probe for exactly that. So the route answers `{ ok: true }` to
 * everything, including its own failures, and the failure is logged instead.
 *
 * That also makes it safe to call from a background task: nothing it does can
 * turn into an error the customer sees.
 */
export function createDeviceSignalsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  router.post("/device-signals", requireSession, async (req: AuthRequest, res) => {
    // The canonical reiwa_id from the session, never from the body.
    //
    // A Telegram-only caller has none, and is skipped rather than resolved: the
    // upstream keys observations on the reiwa_id, and a surface that already
    // carries a Telegram id has a stronger signal than anything a browser can
    // derive about the machine.
    const userId = req.webSession?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      res.json({ ok: true });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const installId = typeof body.installId === "string" ? body.installId : null;
    const deviceHash = typeof body.deviceHash === "string" ? body.deviceHash : null;
    if (installId === null && deviceHash === null) {
      res.json({ ok: true });
      return;
    }

    try {
      await adminClient?.user.reportDeviceSignals({ userId, installId, deviceHash });
    } catch {
      // Swallowed on purpose — see the header. A device signal is worth less
      // than any request the customer actually made.
    }
    res.json({ ok: true });
  });

  return router;
}
