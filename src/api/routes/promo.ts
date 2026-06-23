import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { sendSafeError } from "../lib/error-response.js";

export function createPromoRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  // Identity-agnostic auth: keyed by reiwa_id upstream, so web-first
  // users (no Telegram) can activate codes and read their history. The
  // previous `createSessionMiddleware` + `req.telegramId!` path 401'd
  // every web-auth user and mis-passed a telegramId into the userId slot.
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // POST /api/v1/promocode/activate
  router.post(
    "/promocode/activate",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { code, subscriptionId, confirmCreateNew } = (req.body ?? {}) as Record<string, unknown>;
        if (!code) {
          res.status(400).json({ message: "code is required" });
          return;
        }
        const result = await adminClient?.promocodes.activate(
          resolveUserIdentity(req),
          String(code),
          {
            subscriptionId:
              typeof subscriptionId === "string" && subscriptionId.length > 0
                ? subscriptionId
                : undefined,
            confirmCreateNew: confirmCreateNew === true,
          },
        );
        res.json(result ?? {});
      } catch (e: unknown) {
        sendSafeError(req, res, e, 400, "Promo code activation failed", "promocode/activate");
      }
    },
  );

  // GET /api/v1/promocode/activations — activation history
  router.get(
    "/promocode/activations",
    requireSession,
    async (req: AuthRequest, res) => {
      const { page = "1", limit = "20" } = req.query as Record<string, string>;
      const result = await adminClient?.promocodes.getActivations(
        resolveUserIdentity(req),
        Number(page),
        Number(limit),
      );
      res.json(result ?? { activations: [], total: 0 });
    },
  );

  // GET /api/v1/promocode/eligible-subscriptions?code=...
  router.get(
    "/promocode/eligible-subscriptions",
    requireSession,
    async (req: AuthRequest, res) => {
      const code = String((req.query as { code?: string }).code ?? "").trim();
      if (!code) {
        res.status(400).json({ message: "code is required" });
        return;
      }
      const result = await adminClient?.promocodes.getEligibleSubscriptions(
        resolveUserIdentity(req),
        code,
      );
      res.json(result ?? []);
    },
  );

  return router;
}
