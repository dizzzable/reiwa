import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

export function createReferralsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/referrals/summary
  router.get(
    "/referrals/summary",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.referrals.getSummary(req.telegramId!);
      res.json(result ?? {});
    },
  );

  // POST /api/v1/referrals/invites
  router.post(
    "/referrals/invites",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const invite = await adminClient?.referrals.createInvite(req.telegramId!);
        res.json(invite ?? {});
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // GET /api/v1/referrals/invites — list all invites
  router.get(
    "/referrals/invites",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.referrals.getInviteCapacity(req.telegramId!);
      res.json(result ?? []);
    },
  );

  // POST /api/v1/referrals/invites/:inviteId/revoke
  router.post(
    "/referrals/invites/:inviteId/revoke",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.referrals.revokeInvite(
          req.telegramId!,
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
      const result = await adminClient?.referrals.getRewards(req.telegramId!);
      res.json(result ?? { rewards: [] });
    },
  );

  // POST /api/v1/referrals/exchange/gift-promocode — exchange points
  router.post(
    "/referrals/exchange/gift-promocode",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { points } = (req.body ?? {}) as Record<string, unknown>;
        if (!points) {
          res.status(400).json({ message: "points is required" });
          return;
        }
        const result = await adminClient?.referrals.exchangePointsForGiftPromocode(
          req.telegramId!,
          { points: Number(points) },
        );
        res.json(result ?? {});
      } catch (e: unknown) {
        res.status(400).json({ message: (e as Error).message });
      }
    },
  );

  return router;
}
