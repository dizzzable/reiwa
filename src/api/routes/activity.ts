import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";

export function createActivityRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/activity/transactions
  router.get(
    "/activity/transactions",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.activity.getTransactions(resolveUserIdentity(req));
      res.json(result ?? { transactions: [] });
    },
  );

  // GET /api/v1/activity/add-on-entitlements — the user's "My add-ons" history.
  router.get(
    "/activity/add-on-entitlements",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.activity.getAddOnEntitlements(resolveUserIdentity(req));
      res.json(result ?? { entitlements: [] });
    },
  );

  // GET /api/v1/activity/notifications
  router.get(
    "/activity/notifications",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.activity.getNotifications(resolveUserIdentity(req));
      res.json(result ?? { notifications: [] });
    },
  );

  // GET /api/v1/activity/notifications/unread-count
  // NOTE: must be registered before /:notificationId/read to avoid route shadowing
  router.get(
    "/activity/notifications/unread-count",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.activity.getUnreadCount(resolveUserIdentity(req));
      // rezeis returns `{ unread: number }`; the SPA bell expects `{ count }`.
      // Normalise here (accept either) so a freshly-delivered notification
      // actually lights up the bell instead of always reading 0.
      const raw = (result ?? {}) as { unread?: number; count?: number };
      const count =
        typeof raw.unread === "number"
          ? raw.unread
          : typeof raw.count === "number"
            ? raw.count
            : 0;
      res.json({ count });
    },
  );

  // POST /api/v1/activity/notifications/read-all
  // NOTE: must be registered before /:notificationId/read to avoid route shadowing
  router.post(
    "/activity/notifications/read-all",
    requireSession,
    async (req: AuthRequest, res) => {
      await adminClient?.activity
        .markAllRead(resolveUserIdentity(req))
        .catch(() => {});
      res.json({ ok: true });
    },
  );

  // POST /api/v1/activity/notifications/:notificationId/read
  router.post(
    "/activity/notifications/:notificationId/read",
    requireSession,
    async (req: AuthRequest, res) => {
      await adminClient?.activity
        .markRead(
          resolveUserIdentity(req),
          String(req.params["notificationId"]),
        )
        .catch(() => {});
      res.json({ ok: true });
    },
  );

  return router;
}
