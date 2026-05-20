import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

export function createPromoRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // POST /api/v1/promocode/activate
  router.post(
    "/promocode/activate",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { code, subscriptionId } = (req.body ?? {}) as Record<
          string,
          unknown
        >;
        if (!code) {
          res.status(400).json({ message: "code is required" });
          return;
        }
        const result = await adminClient?.activatePromocode(
          req.telegramId!,
          String(code),
        );
        res.json(result ?? {});
      } catch (e: unknown) {
        res.status(400).json({ message: (e as Error).message });
      }
    },
  );

  // GET /api/v1/promocode/activations — activation history
  router.get(
    "/promocode/activations",
    requireSession,
    async (req: AuthRequest, res) => {
      const { page = "1", limit = "20" } = req.query as Record<string, string>;
      const result = await adminClient?.getPromoActivations(
        req.telegramId!,
        Number(page),
        Number(limit),
      );
      res.json(result ?? { activations: [], total: 0 });
    },
  );

  // GET /api/v1/promocode/eligible-subscriptions
  router.get(
    "/promocode/eligible-subscriptions",
    requireSession,
    async (req: AuthRequest, res) => {
      const result = await adminClient?.getEligibleSubscriptions(
        req.telegramId!,
      );
      res.json(result ?? []);
    },
  );

  return router;
}
