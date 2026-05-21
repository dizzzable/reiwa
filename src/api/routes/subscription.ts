import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

export function createSubscriptionRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/subscription
  router.get("/subscription", requireSession, async (req: AuthRequest, res) => {
    try {
      const sub = await adminClient?.getUserSubscription(req.telegramId!);
      res.json(sub ?? null);
    } catch {
      res.json(null);
    }
  });

  // POST /api/v1/subscription/action-policy
  router.post(
    "/subscription/action-policy",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { planId } = (req.body ?? {}) as Record<string, unknown>;
        const policy = await adminClient?.getActionPolicy(
          req.telegramId!,
          planId !== undefined ? Number(planId) : undefined,
        );
        res.json(policy ?? {});
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // GET /api/v1/subscriptions/all — all user subscriptions (historical)
  router.get(
    "/subscriptions/all",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.getAllUserSubscriptions(
          req.telegramId!,
        );
        res.json(result ?? { subscriptions: [] });
      } catch {
        res.json({ subscriptions: [] });
      }
    },
  );

  // POST /api/v1/subscription/trial — activate trial
  router.post(
    "/subscription/trial",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.activateTrial(req.telegramId!);
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(400).json({ message: (e as Error).message });
      }
    },
  );

  // POST /api/v1/subscription/quote
  router.post(
    "/subscription/quote",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { planId, durationDays, gatewayType } = (req.body ??
          {}) as Record<string, unknown>;
        if (!planId || !durationDays || !gatewayType) {
          res.status(400).json({
            message: "planId, durationDays and gatewayType are required",
          });
          return;
        }
        const quote = await adminClient?.getQuote(
          req.telegramId!,
          Number(planId),
          Number(durationDays),
          String(gatewayType),
        );
        res.json(quote ?? {});
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  return router;
}
