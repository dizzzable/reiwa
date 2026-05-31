import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { PointsExchangeType } from "../../infrastructure/admin-client/namespaces/referrals.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";

export function createReferralsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/referrals/summary
  router.get(
    "/referrals/summary",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.referrals.getSummary(resolveUserIdentity(req));
      res.json(result ?? {});
    },
  );

  // POST /api/v1/referrals/invites
  router.post(
    "/referrals/invites",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const invite = await adminClient?.referrals.createInvite(resolveUserIdentity(req));
        res.json(invite ?? {});
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // GET /api/v1/referrals/invite-capacity — slots used/remaining
  router.get(
    "/referrals/invite-capacity",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.referrals.getInviteCapacity(resolveUserIdentity(req));
      res.json(result ?? { totalSlots: null, usedSlots: 0, remainingSlots: null, canCreateInvite: true });
    },
  );

  // GET /api/v1/referrals/invited — paginated list of invited users
  router.get(
    "/referrals/invited",
    requireSession,
    async (req: AuthRequest, res) => {
      const page = Number(req.query["page"]) || 1;
      const limit = Number(req.query["limit"]) || 20;
      const result = await adminClient?.referrals.getInvitedUsers(
        resolveUserIdentity(req),
        page,
        limit,
      );
      res.json(result ?? { items: [], total: 0, page, limit });
    },
  );

  // POST /api/v1/referrals/invites/:inviteId/revoke
  router.post(
    "/referrals/invites/:inviteId/revoke",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.referrals.revokeInvite(
          resolveUserIdentity(req),
          String(req.params["inviteId"]),
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(400).json({ message: (e as Error).message });
      }
    },
  );

  // GET /api/v1/referrals/rewards — rewards history
  router.get(
    "/referrals/rewards",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.referrals.getRewards(resolveUserIdentity(req));
      res.json(result ?? { rewards: [] });
    },
  );

  // GET /api/v1/referrals/exchange/options — available exchange types + balance
  router.get(
    "/referrals/exchange/options",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.referrals.getExchangeOptions(resolveUserIdentity(req));
        res.json(result ?? { exchangeEnabled: false, pointsBalance: 0, types: [] });
      } catch {
        res.json({ exchangeEnabled: false, pointsBalance: 0, types: [] });
      }
    },
  );

  // POST /api/v1/referrals/exchange — execute a points exchange
  router.post(
    "/referrals/exchange",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { type, points, subscriptionId } = (req.body ?? {}) as Record<
          string,
          unknown
        >;
        if (typeof type !== "string" || type.length === 0) {
          res.status(400).json({ message: "type is required" });
          return;
        }
        if (points === undefined || points === null || Number(points) <= 0) {
          res.status(400).json({ message: "points must be a positive number" });
          return;
        }
        const result = await adminClient?.referrals.exchangePoints(resolveUserIdentity(req), {
          type: type as PointsExchangeType,
          points: Number(points),
          ...(typeof subscriptionId === "string" && subscriptionId.length > 0
            ? { subscriptionId }
            : {}),
        });
        res.json(result ?? {});
      } catch (e: unknown) {
        res.status(400).json({ message: (e as Error).message });
      }
    },
  );

  return router;
}
