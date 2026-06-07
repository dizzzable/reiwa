import { Router, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

import type { ReiwaConfig } from "../../config.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { collectSystemHealth } from "../../lib/system-metrics.js";

/**
 * Internal metrics endpoint — exposes reiwa's host + process health in the
 * same `SystemHealthResponse` shape rezeis-admin produces for itself, so the
 * admin dashboard can render reiwa's server in a second monitoring tab
 * (works whether reiwa is on the same VPS or a different one).
 *
 * Auth: a shared-secret header `x-internal-token` compared (constant-time)
 * against `REZEIS_WEBHOOK_SECRET` — the same value admin holds as
 * `WEBHOOK_SECRET_HEADER`. No body, so the webhook HMAC scheme doesn't apply;
 * the bearer-style shared secret over TLS is sufficient for a read-only
 * metrics probe. When the secret is unset the endpoint is disabled (503).
 */
export function createInternalMetricsRouter(deps: { config: ReiwaConfig }) {
  const router = Router();
  const secret = deps.config.REZEIS_WEBHOOK_SECRET;

  router.get("/internal/metrics", async (req: Request, res: Response) => {
    if (!secret) {
      res.status(503).json({ message: "metrics disabled" });
      return;
    }
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEqual(provided, secret)) {
      getRequestLogger(req).warn({ remoteAddress: req.ip }, "internal/metrics: rejected");
      res.status(401).json({ message: "unauthorized" });
      return;
    }
    try {
      const health = await collectSystemHealth();
      res.json(health);
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "internal/metrics failed");
      res.status(500).json({ message: "internal" });
    }
  });

  return router;
}

/** Constant-time string compare that never throws on length mismatch. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
