import { Router, Request, Response } from "express";
import { z } from "zod";
import type { AdminClient } from "../../lib/admin-client.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url("Endpoint must be a valid URL"),
    keys: z.object({
      p256dh: z.string().min(1, "p256dh key is required"),
      auth: z.string().min(1, "auth key is required"),
    }),
  }),
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

  // ── POST /api/v1/push/subscribe ─────────────────────────────────────────────
  router.post("/push/subscribe", async (req: Request, res: Response) => {
    try {
      // Require authentication
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      // Validate request body with Zod
      const parsed = pushSubscribeSchema.safeParse(req.body);
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
      const { subscription } = parsed.data;

      // Proxy to Rezeis_Admin
      const result = await adminClient.pushSubscribe(userId, subscription);

      res.json({ success: result.success });
    } catch (e: unknown) {
      const errMsg = (e as Error).message ?? "";

      if (errMsg.includes("409") || errMsg.toLowerCase().includes("limit")) {
        res.status(409).json({ message: "Maximum push subscriptions reached (5 per account)" });
        return;
      }
      if (errMsg.includes("503") || errMsg.includes("unavailable")) {
        res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
        return;
      }

      getRequestLogger(req).error({ err: errMsg }, "push/subscribe failed");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── DELETE /api/v1/push/unsubscribe ─────────────────────────────────────────
  router.delete("/push/unsubscribe", async (req: Request, res: Response) => {
    try {
      // Require authentication
      if (!req.webSession || !req.webSessionId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      // Validate request body with Zod
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

      // Proxy unsubscribe to Rezeis_Admin — permanently remove subscription.
      // If removal fails, retain existing data and allow reuse if still valid.
      try {
        const result = await adminClient.pushUnsubscribe(userId, endpoint);
        res.json({ success: result.success });
      } catch (unsubErr: unknown) {
        const unsubErrMsg = (unsubErr as Error).message ?? "";

        // If the subscription was not found (already removed), treat as success
        if (unsubErrMsg.includes("404")) {
          res.json({ success: true });
          return;
        }

        // If removal fails, retain existing data and allow reuse if still valid
        // Return a 502 to indicate the upstream failed but data is preserved
        getRequestLogger(req).error({ err: unsubErrMsg }, "push/unsubscribe - Removal failed, retaining subscription:");
        res.status(502).json({
          message: "Failed to remove subscription. Existing subscription data retained.",
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
