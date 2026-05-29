import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { PurchaseType } from "../../infrastructure/admin-client/namespaces/subscription.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";

export function createSubscriptionRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/subscription
  router.get("/subscription", requireSession, async (req: AuthRequest, res) => {
    try {
      const sub = await adminClient?.subscription.getActive(resolveUserIdentity(req));
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
        const { subscriptionId } = (req.body ?? {}) as Record<string, unknown>;
        const policy = await adminClient?.subscription.getActionPolicy(
          resolveUserIdentity(req),
          subscriptionId !== undefined ? String(subscriptionId) : undefined,
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
        const result = await adminClient?.subscription.getAll(resolveUserIdentity(req));
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
        const result = await adminClient?.trial.activate(resolveUserIdentity(req));
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
        const { planId, durationDays, gatewayType, purchaseType, subscriptionId } =
          (req.body ?? {}) as Record<string, unknown>;
        if (!planId || !durationDays || !gatewayType) {
          res.status(400).json({
            message: "planId, durationDays and gatewayType are required",
          });
          return;
        }
        const quote = await adminClient?.subscription.getQuote(
          resolveUserIdentity(req),
          (typeof purchaseType === "string" ? purchaseType : "NEW") as PurchaseType,
          String(planId),
          Number(durationDays),
          String(gatewayType),
          subscriptionId !== undefined ? String(subscriptionId) : undefined,
        );
        res.json(quote ?? {});
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  return router;
}
