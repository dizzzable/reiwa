import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

export function createActivityRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/activity/transactions
  router.get(
    "/activity/transactions",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.activity.getTransactions(req.telegramId!);
      res.json(result ?? { transactions: [] });
    },
  );

  // GET /api/v1/activity/notifications
  router.get(
    "/activity/notifications",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.activity.getNotifications(req.telegramId!);
      res.json(result ?? { notifications: [] });
    },
  );

  // GET /api/v1/activity/notifications/unread-count
  // NOTE: must be registered before /:notificationId/read to avoid route shadowing
  router.get(
    "/activity/notifications/unread-count",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.activity.getUnreadCount(req.telegramId!);
      res.json(result ?? { count: 0 });
    },
  );

  // POST /api/v1/activity/notifications/read-all
  // NOTE: must be registered before /:notificationId/read to avoid route shadowing
  router.post(
    "/activity/notifications/read-all",
    requireSession,
    async (req: AuthRequest, res) => {
      await adminClient?.activity
        .markAllRead(req.telegramId!)
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
          req.telegramId!,
          String(req.params["notificationId"]),
        )
        .catch(() => {});
      res.json({ ok: true });
    },
  );

  return router;
}
