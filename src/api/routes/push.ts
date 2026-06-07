import { Router, Request, Response } from "express";
import { z } from "zod";
import type { AdminClient } from "../../lib/admin-client.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { describeUpstreamError, isUpstreamStatus } from "../lib/upstream-error.js";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

const pushSubscribeSchema = z.object({
  endpoint: z.string().url("Endpoint must be a valid URL"),
  keys: z.object({
    p256dh: z.string().min(1, "p256dh key is required"),
    auth: z.string().min(1, "auth key is required"),
  }),
  userAgent: z.string().max(512).optional(),
});

const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url("Endpoint must be a valid URL"),
});

// ── Router Factory ──────────────────────────────────────────────────────────

export function createPushRouter(deps: {
  adminClient: AdminClient | null;
  webSessionStore: WebSessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient } = deps;
  const router = Router();

  // ── GET /api/v1/push/public-key ────────────────────────────────────────────
  //
  // Returns the operator-configured VAPID public key. The SPA calls
  // this once before invoking `pushManager.subscribe(...)`. Empty
  // string means push is disabled — the SPA should hide its opt-in
  // UI rather than try to subscribe with no key.
  router.get("/push/public-key", async (req: Request, res: Response) => {
    try {
      if (!adminClient) {
        res.json({ publicKey: "" });
        return;
      }
      const result = await adminClient.push.getPublicKey();
      res.json(result);
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "push/public-key failed");
      res.json({ publicKey: "" });
    }
  });

  // ── POST /api/v1/push/subscribe ─────────────────────────────────────────────
  router.post("/push/subscribe", async (req: Request, res: Response) => {
    try {
      // Require authentication
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      // Validate request body with Zod. Accept either the wrapped
      // `{ subscription: { endpoint, keys } }` shape (legacy SPA
      // bundles still in service-worker cache) OR the flat
      // `{ endpoint, keys, userAgent }` shape (new SPA).
      const flat = pushSubscribeSchema.safeParse(req.body);
      let endpoint: string;
      let p256dh: string;
      let auth: string;
      let userAgent: string | undefined;
      if (flat.success) {
        endpoint = flat.data.endpoint;
        p256dh = flat.data.keys.p256dh;
        auth = flat.data.keys.auth;
        userAgent = flat.data.userAgent;
      } else {
        const wrapped = z.object({
          subscription: z.object({
            endpoint: z.string().url(),
            keys: z.object({
              p256dh: z.string().min(1),
              auth: z.string().min(1),
            }),
          }),
        }).safeParse(req.body);
        if (!wrapped.success) {
          res.status(400).json({
            message: "Validation failed",
            errors: flat.error.issues.map((i) => ({
              field: i.path.join("."),
              message: i.message,
            })),
          });
          return;
        }
        endpoint = wrapped.data.subscription.endpoint;
        p256dh = wrapped.data.subscription.keys.p256dh;
        auth = wrapped.data.subscription.keys.auth;
      }

      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      const userId = req.webSession.userId;
      const result = await adminClient.push.subscribe(
        userId,
        { endpoint, keys: { p256dh, auth } },
        userAgent,
      );

      res.json({ success: result.success });
    } catch (e: unknown) {
      const { message: errMsg } = describeUpstreamError(e);

      if (isUpstreamStatus(e, 409) || errMsg.toLowerCase().includes("limit")) {
        res.status(409).json({ message: "Maximum push subscriptions reached" });
        return;
      }
      if (isUpstreamStatus(e, 503) || errMsg.includes("unavailable")) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "push/subscribe failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/v1/push/unsubscribe ──────────────────────────────────────────
  //
  // POST instead of DELETE because some proxies strip the body from
  // DELETE requests, and we need the endpoint in the body to identify
  // which subscription to remove.
  router.post("/push/unsubscribe", async (req: Request, res: Response) => {
    try {
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      const parsed = pushUnsubscribeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }
      if (!adminClient) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }
      const userId = req.webSession.userId;
      const { endpoint } = parsed.data;
      try {
        const result = await adminClient.push.unsubscribe(userId, endpoint);
        res.json({ success: result.success });
      } catch (unsubErr: unknown) {
        const { message: unsubErrMsg } = describeUpstreamError(unsubErr);
        if (isUpstreamStatus(unsubErr, 404)) {
          // Already removed — idempotent success.
          res.json({ success: true });
          return;
        }
        getRequestLogger(req).error(
          { err: unsubErrMsg },
          "push/unsubscribe upstream failed",
        );
        res.status(502).json({
          message: "Failed to remove subscription",
          retained: true,
        });
      }
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "push/unsubscribe failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  return router;
}
