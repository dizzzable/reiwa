import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";

export function createPlansRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient } = deps;
  const router = Router();

  // GET /api/v1/plans
  router.get("/plans", async (_req, res) => {
    try {
      const plans = await adminClient?.catalog.getPublicPlans();
      res.json(plans ?? []);
    } catch (e: unknown) {
      res.status(500).json({ message: (e as Error).message });
    }
  });

  // GET /api/v1/gateways
  router.get("/gateways", async (req, res) => {
    try {
      // Drop gateways that can't operate in the caller's context. In the
      // browser cabinet (`web`) this hides TELEGRAM_STARS, which only
      // works inside a Telegram invoice. TMA callers still get Stars.
      const ctx = (req as { context?: string }).context;
      const channel = ctx === "tma" ? "TMA" : "WEB";
      const gateways = await adminClient?.payments.getEnabledGateways(channel);
      res.json(gateways ?? []);
    } catch (e: unknown) {
      res.status(500).json({ message: (e as Error).message });
    }
  });

  return router;
}
