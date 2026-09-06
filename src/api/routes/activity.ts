import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { invalidateStaleUserSession } from "../lib/stale-user-session.js";
import { describeUpstreamError } from "../lib/upstream-error.js";

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
      try {
        const result = await adminClient?.activity.getNotifications(resolveUserIdentity(req));
        res.json(result ?? { notifications: [] });
      } catch (error: unknown) {
        if (await invalidateStaleUserSession(req, error)) {
          res.status(401).json({ message: "Session expired" });
          return;
        }
        throw error;
      }
    },
  );

  // GET /api/v1/activity/notifications/preferences — the subscriber's own
  // switches. Registered before the `/:notificationId` routes for the same
  // reason `unread-count` is: a static segment loses to a parameter that was
  // declared first.
  router.get(
    "/activity/notifications/preferences",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.activity.getNotificationPrefs(resolveUserIdentity(req));
        // An unreachable panel answers "nothing stored, nothing offered", and
        // the screen then renders no switches rather than switches that do
        // nothing — which is the state this whole pair replaced.
        res.json(result ?? { prefs: {}, available: [] });
      } catch (error: unknown) {
        if (await invalidateStaleUserSession(req, error)) {
          res.status(401).json({ message: "Session expired" });
          return;
        }
        // A panel that predates this pair answers 404 for the route itself.
        // That is the ORDINARY state of an out-of-order upgrade, not a fault:
        // without this the rejection is unhandled, every visit to the settings
        // screen answers 500, and each react-query retry files its own report
        // to the operator. The empty set is the shape the screen already
        // handles — it draws no switches.
        if (describeUpstreamError(error).status === 404) {
          res.json({ prefs: {}, available: [] });
          return;
        }
        throw error;
      }
    },
  );

  // POST /api/v1/activity/notifications/preferences
  router.post(
    "/activity/notifications/preferences",
    requireSession,
    async (req: AuthRequest, res) => {
      const prefs = (req.body as { prefs?: unknown } | undefined)?.prefs ?? {};
      try {
        const result = await adminClient?.activity.updateNotificationPrefs(
          resolveUserIdentity(req),
          prefs,
        );
        res.json(result ?? { prefs: {}, available: [] });
      } catch (error: unknown) {
        if (await invalidateStaleUserSession(req, error)) {
          res.status(401).json({ message: "Session expired" });
          return;
        }
        // 404 means the panel cannot store the choice at all. The empty set
        // makes the screen drop the switches rather than leave one that looks
        // saved and is not.
        if (describeUpstreamError(error).status === 404) {
          res.json({ prefs: {}, available: [] });
          return;
        }
        throw error;
      }
    },
  );

  // GET /api/v1/activity/notifications/unread-count
  // NOTE: must be registered before /:notificationId/read to avoid route shadowing
  router.get(
    "/activity/notifications/unread-count",
    requireSession,
    async (req: AuthRequest, res) => {
      let result: unknown;
      try {
        result = await adminClient?.activity.getUnreadCount(resolveUserIdentity(req));
      } catch (error: unknown) {
        if (await invalidateStaleUserSession(req, error)) {
          res.status(401).json({ message: "Session expired" });
          return;
        }
        throw error;
      }
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
      if (adminClient === null) {
        res.status(503).json({ message: "Notifications unavailable" });
        return;
      }
      try {
        await adminClient.activity.markAllRead(resolveUserIdentity(req));
        res.json({ ok: true });
      } catch (error: unknown) {
        if (await invalidateStaleUserSession(req, error)) {
          res.status(401).json({ message: "Session expired" });
          return;
        }
        throw error;
      }
    },
  );

  // POST /api/v1/activity/notifications/:notificationId/read
  router.post(
    "/activity/notifications/:notificationId/read",
    requireSession,
    async (req: AuthRequest, res) => {
      if (adminClient === null) {
        res.status(503).json({ message: "Notifications unavailable" });
        return;
      }
      try {
        await adminClient.activity.markRead(
          resolveUserIdentity(req),
          String(req.params["notificationId"]),
        );
        res.json({ ok: true });
      } catch (error: unknown) {
        if (await invalidateStaleUserSession(req, error)) {
          res.status(401).json({ message: "Session expired" });
          return;
        }
        throw error;
      }
    },
  );

  return router;
}
