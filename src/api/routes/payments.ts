import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { buildPaymentReturnUrl } from "../../lib/payment-return-url.js";

export function createPaymentsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore, config } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // POST /api/v1/payments/checkout
  //
  // Context-aware redirect resolution:
  //  - When the request originates from a Telegram Mini App (`req.context === "tma"`)
  //    we ask the gateway to redirect the user back to Telegram via a deep link
  //    derived from `BOT_USERNAME` / `BOT_MINI_APP_NAME`.
  //  - When the request originates from a regular browser (`req.context === "web"`)
  //    we redirect to `${REIWA_DOMAIN}/payment-return`.
  //  - The client may still supply explicit `successUrl` / `failUrl` overrides
  //    (e.g. for return-to-specific-flow) which always win when present.
  router.post(
    "/payments/checkout",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const {
          planId,
          durationDays,
          gatewayType,
          successUrl: bodySuccessUrl,
          failUrl: bodyFailUrl,
          // Legacy alias kept for backwards-compatibility with older SPA bundles.
          returnUrl: legacyReturnUrl,
        } = (req.body ?? {}) as Record<string, unknown>;

        if (!planId || !durationDays || !gatewayType) {
          res.status(400).json({
            message: "planId, durationDays and gatewayType are required",
          });
          return;
        }

        const successOverride =
          typeof bodySuccessUrl === "string"
            ? bodySuccessUrl
            : typeof legacyReturnUrl === "string"
              ? legacyReturnUrl
              : null;
        const failOverride = typeof bodyFailUrl === "string" ? bodyFailUrl : null;

        const successUrl = buildPaymentReturnUrl({
          context: req.context ?? "web",
          config,
          override: successOverride,
        });
        const failUrl = buildPaymentReturnUrl({
          context: req.context ?? "web",
          config,
          override: failOverride ?? successOverride,
        });

        const checkout = await adminClient?.createCheckout(
          req.telegramId!,
          Number(planId),
          Number(durationDays),
          String(gatewayType),
          successUrl,
          failUrl,
        );
        res.json(checkout ?? {});
      } catch (e: unknown) {
        res.status(500).json({ message: (e as Error).message });
      }
    },
  );

  // POST /api/v1/payments/webhooks/:gatewayType
  // NOTE: must be registered before /:paymentId to avoid route shadowing
  router.post("/payments/webhooks/:gatewayType", async (req, res) => {
    try {
      const { gatewayType } = req.params as Record<string, string>;
      const result = await adminClient?.forwardWebhook(gatewayType, req.body);
      res.json(result ?? { received: true });
    } catch (e: unknown) {
      res.status(500).json({ message: (e as Error).message });
    }
  });

  // GET /api/v1/payments/:paymentId
  router.get(
    "/payments/:paymentId",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const status = await adminClient?.getPaymentStatus(
          String(req.params["paymentId"]),
        );
        res.json(status ?? {});
      } catch {
        res.status(404).json({ message: "Payment not found" });
      }
    },
  );

  return router;
}
