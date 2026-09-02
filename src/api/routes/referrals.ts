import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { PointsExchangeType } from "../../infrastructure/admin-client/namespaces/referrals.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { sendSafeError } from "../lib/error-response.js";
import { isUpstreamStatus } from "../lib/upstream-error.js";

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
        sendSafeError(req, res, e, 500, "Failed to create invite", "referrals/invites");
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
        sendSafeError(req, res, e, 400, "Failed to revoke invite", "referrals/revoke");
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

  // GET /api/v1/referrals/points/ledger — keyset-paginated points history
  //
  // A panel older than this route has no such endpoint and answers 404. That
  // 404 is forwarded rather than flattened into an empty page: an empty page
  // reads to the SPA as "you have earned nothing yet" and it would draw an
  // empty-state under a heading, where the honest answer is to draw nothing
  // at all. The two cases are only distinguishable by the status.
  router.get(
    "/referrals/points/ledger",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const rawCursor = req.query["cursor"];
        const cursor =
          typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : undefined;
        const limit = Number(req.query["limit"]) || 20;
        const result = await adminClient?.referrals.getPointsLedger(
          resolveUserIdentity(req),
          cursor,
          limit,
        );
        res.json(result ?? { items: [], nextCursor: null });
      } catch (e: unknown) {
        if (isUpstreamStatus(e, 404)) {
          res.status(404).json({ message: "Points history not available" });
          return;
        }
        sendSafeError(
          req,
          res,
          e,
          500,
          "Failed to load points history",
          "referrals/points-ledger",
        );
      }
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
        const { type, points, subscriptionId, idempotencyKey } = (req.body ?? {}) as Record<
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
          ...(typeof idempotencyKey === "string" && idempotencyKey.length > 0
            ? { idempotencyKey }
            : {}),
        });
        if (
          result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          typeof (result as { error?: unknown }).error === "string"
        ) {
          res.json({
            success: false,
            error: (result as { error: string }).error,
          });
          return;
        }
        res.json(result ?? {});
      } catch (e: unknown) {
        sendSafeError(req, res, e, 400, "Points exchange failed", "referrals/exchange");
      }
    },
  );

  return router;
}
