import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { sendSafeError } from "../lib/error-response.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";

export function createOlcrtcRouter(deps: {
  readonly adminClient: AdminClient | null;
  readonly sessionStore: SessionStore | null;
}) {
  const router = Router();
  const requireSession = createFlexibleSessionMiddleware(deps.sessionStore);

  router.get("/olcrtc/subscription", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await deps.adminClient?.olcrtc.getSubscription(resolveUserIdentity(req));
      res.json(result ?? { enabled: false, eligible: false, status: "DISABLED", subscription: null });
    } catch (e: unknown) {
      sendSafeError(req, res, e, 500, "Failed to load restricted connection", "olcrtc/subscription");
    }
  });

  router.post("/olcrtc/subscription/provision", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await deps.adminClient?.olcrtc.provisionSubscription(resolveUserIdentity(req));
      res.json(result ?? { enabled: false, eligible: false, status: "DISABLED", subscription: null });
    } catch (e: unknown) {
      sendSafeError(req, res, e, 500, "Failed to provision restricted connection", "olcrtc/provision");
    }
  });

  return router;
}
