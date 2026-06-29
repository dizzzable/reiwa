import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { PurchaseType } from "../../infrastructure/admin-client/namespaces/payments.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { requireMode, type AccessModeGate } from "../middleware/access-mode.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { buildPaymentReturnUrl, resolvePurchaseContext } from "../../lib/payment-return-url.js";
import { sendSafeError } from "../lib/error-response.js";

/**
 * Maps a request body's `purchaseType` field to the matching access-mode
 * gate. RENEW is special-cased so PURCHASE_BLOCKED keeps it open while
 * gating NEW / ADDITIONAL / UPGRADE / TRIAL.
 */
function gateForPurchaseType(body: unknown): AccessModeGate {
  const type = (body as { purchaseType?: unknown } | undefined)?.purchaseType;
  if (type === 'UPGRADE') return 'purchase.upgrade';
  if (type === 'RENEW') return 'purchase.renewal';
  return 'purchase.new';
}

export function createPaymentsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore, config } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
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
    requireMode((req) => gateForPurchaseType(req.body)),
    async (req: AuthRequest, res) => {
      try {
        const {
          planId,
          durationDays,
          gatewayType,
          purchaseType,
          subscriptionId,
          deviceType,
          // Explicit origin hint from the SPA ("tma" | "web"). Decides whether
          // the post-payment redirect returns the user to Telegram or the web
          // app. See resolvePurchaseContext for why this is sent in the body.
          source,
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

        const context = resolvePurchaseContext(req.context, source);

        const successUrl = buildPaymentReturnUrl({
          context,
          config,
          override: successOverride,
        });
        const failUrl = buildPaymentReturnUrl({
          context,
          config,
          override: failOverride ?? successOverride,
        });

        if (!adminClient) {
          res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
          return;
        }

        const checkout = await adminClient.payments.createCheckout(
          resolveUserIdentity(req),
          (typeof purchaseType === "string" ? purchaseType : "NEW") as PurchaseType,
          String(planId),
          Number(durationDays),
          String(gatewayType),
          {
            successUrl,
            failUrl,
            ...(typeof deviceType === "string" ? { deviceType } : {}),
            ...(subscriptionId !== undefined ? { subscriptionId: String(subscriptionId) } : {}),
          },
        );
        res.json(checkout ?? {});
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to create checkout", "payments/checkout");
      }
    },
  );

  // POST /api/v1/payments/renewal-checkout
  //
  // Combined multi-subscription renewal: one provider checkout for the
  // summed total of N renewals. Each id renews on its original (or
  // replacement) plan and originally purchased duration on rezeis-admin.
  // Source-aware return URL resolves the same way as /payments/checkout
  // (TMA deep link vs web origin), with explicit overrides winning.
  router.post(
    "/payments/renewal-checkout",
    requireSession,
    requireMode('purchase.renewal'),
    async (req: AuthRequest, res) => {
      try {
        const {
          subscriptionIds,
          gatewayType,
          source,
          durations,
          plans,
          successUrl: bodySuccessUrl,
          failUrl: bodyFailUrl,
        } = (req.body ?? {}) as Record<string, unknown>;

        if (
          !Array.isArray(subscriptionIds) ||
          subscriptionIds.length === 0 ||
          !subscriptionIds.every((id) => typeof id === "string" && id.length > 0)
        ) {
          res.status(400).json({ message: "subscriptionIds must be a non-empty array of ids" });
          return;
        }
        if (typeof gatewayType !== "string" || gatewayType.length === 0) {
          res.status(400).json({ message: "gatewayType is required" });
          return;
        }
        const durationsValid =
          Array.isArray(durations) &&
          durations.every(
            (d) =>
              d !== null &&
              typeof d === "object" &&
              typeof (d as { subscriptionId?: unknown }).subscriptionId === "string" &&
              Number.isFinite((d as { days?: unknown }).days),
          );
        const plansValid =
          Array.isArray(plans) &&
          plans.every(
            (p) =>
              p !== null &&
              typeof p === "object" &&
              typeof (p as { subscriptionId?: unknown }).subscriptionId === "string" &&
              typeof (p as { planId?: unknown }).planId === "string",
          );

        const successOverride =
          typeof bodySuccessUrl === "string" ? bodySuccessUrl : null;
        const failOverride =
          typeof bodyFailUrl === "string" ? bodyFailUrl : null;
        const context = resolvePurchaseContext(req.context, source);

        const successUrl = buildPaymentReturnUrl({
          context,
          config,
          override: successOverride,
        });
        const failUrl = buildPaymentReturnUrl({
          context,
          config,
          override: failOverride ?? successOverride,
        });

        if (!adminClient) {
          res
            .status(503)
            .json({ message: "Service unavailable. Please retry after 30 seconds." });
          return;
        }

        const result = await adminClient.payments.createRenewalCheckout(
          resolveUserIdentity(req),
          {
            subscriptionIds: subscriptionIds as readonly string[],
            gatewayType,
            channel: context === "tma" ? "TMA" : "WEB",
            successUrl,
            failUrl,
            ...(durationsValid
              ? {
                  durations: (durations as ReadonlyArray<{ subscriptionId: string; days: number }>).map(
                    (d) => ({ subscriptionId: String(d.subscriptionId), days: Number(d.days) }),
                  ),
                }
              : {}),
            ...(plansValid
              ? {
                  plans: (plans as ReadonlyArray<{ subscriptionId: string; planId: string }>).map(
                    (p) => ({ subscriptionId: String(p.subscriptionId), planId: String(p.planId) }),
                  ),
                }
              : {}),
          },
        );
        res.json(result ?? {});
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to create renewal checkout", "payments/renewal-checkout");
      }
    },
  );

  // POST /api/v1/payments/webhooks/:gatewayType
  // NOTE: must be registered before /:paymentId to avoid route shadowing
  router.post("/payments/webhooks/:gatewayType", async (req, res) => {
    try {
      const { gatewayType } = req.params as Record<string, string>;
      const result = await adminClient?.payments.forwardWebhook(gatewayType, req.body);
      res.json(result ?? { received: true });
    } catch (e: unknown) {
      sendSafeError(req, res, e, 500, "Webhook processing failed", "payments/webhooks");
    }
  });

  // GET /api/v1/payments/:paymentId
  router.get(
    "/payments/:paymentId",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const status = await adminClient?.payments.getStatus(
          String(req.params["paymentId"]),
          resolveUserIdentity(req),
        );
        res.json(status ?? {});
      } catch {
        res.status(404).json({ message: "Payment not found" });
      }
    },
  );

  return router;
}
