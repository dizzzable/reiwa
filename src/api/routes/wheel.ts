import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { isUpstreamStatus } from "../lib/upstream-error.js";

/** A client handle long enough to be a uuid and short enough not to be abuse. */
const KEY_MIN = 8;
const KEY_MAX = 100;

/**
 * The wheel of fortune, for the person spinning it.
 *
 * Session-scoped like the quests surface: the identity is resolved from the
 * reiwa session and forwarded as `:userRef`, so a person can only ever spin,
 * buy for, and read their own wheel.
 *
 * ── Why the idempotency key comes from the browser ────────────────────────
 *
 * A spin costs something. A double tap, a flaky connection, a reload of the
 * tab mid-request — each of those is a second HTTP call for one intended
 * spin, and a handle minted here would be a NEW handle on every one of them,
 * which is exactly the case it exists to survive. So the browser makes one
 * per intended spin and this route only checks its shape.
 */
export function createWheelRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  const readKey = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length < KEY_MIN || trimmed.length > KEY_MAX) return null;
    return trimmed;
  };

  // GET /api/v1/wheel — sectors, balances, the free spin. Never the odds.
  router.get("/wheel", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.wheel.view(resolveUserIdentity(req));
      res.json(
        result ?? {
          enabled: false,
          sectors: [],
          spinBalance: 0,
          pointsBalance: 0,
          freeSpin: { available: false, availableAt: null },
          spinPricePoints: null,
          canSpin: false,
        },
      );
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "GET /wheel failed");
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/v1/wheel/history — this person's own spins.
  router.get("/wheel/history", requireSession, async (req: AuthRequest, res) => {
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const limitRaw = Number(req.query.limit);
    try {
      const result = await adminClient?.wheel.history(resolveUserIdentity(req), {
        cursor,
        ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.trunc(limitRaw) } : {}),
      });
      res.json(result ?? { items: [], nextCursor: null });
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "GET /wheel/history failed");
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/v1/wheel/spin — one spin.
  router.post("/wheel/spin", requireSession, async (req: AuthRequest, res) => {
    const idempotencyKey = readKey(req.body?.idempotencyKey);
    if (idempotencyKey === null) {
      res.status(400).json({ error: "invalid_key" });
      return;
    }
    try {
      const result = await adminClient?.wheel.spin(resolveUserIdentity(req), idempotencyKey);
      res.json(result ?? { spun: false, reason: "WHEEL_DISABLED" });
    } catch (err: unknown) {
      getRequestLogger(req).warn({ err }, "POST /wheel/spin failed");
      const status = isUpstreamStatus(err, 400) ? 400 : isUpstreamStatus(err, 404) ? 404 : 500;
      res.status(status).json({ error: status === 500 ? "internal" : "spin_rejected" });
    }
  });

  // POST /api/v1/wheel/buy — buy spins with points.
  router.post("/wheel/buy", requireSession, async (req: AuthRequest, res) => {
    const idempotencyKey = readKey(req.body?.idempotencyKey);
    const count = Number(req.body?.count);
    if (idempotencyKey === null) {
      res.status(400).json({ error: "invalid_key" });
      return;
    }
    if (!Number.isInteger(count) || count < 1) {
      res.status(400).json({ error: "invalid_count" });
      return;
    }
    try {
      const result = await adminClient?.wheel.buy(
        resolveUserIdentity(req),
        count,
        idempotencyKey,
      );
      res.json(result ?? {});
    } catch (err: unknown) {
      getRequestLogger(req).warn({ err, count }, "POST /wheel/buy failed");
      const status = isUpstreamStatus(err, 400) ? 400 : isUpstreamStatus(err, 404) ? 404 : 500;
      res.status(status).json({ error: status === 500 ? "internal" : "purchase_rejected" });
    }
  });

  return router;
}
