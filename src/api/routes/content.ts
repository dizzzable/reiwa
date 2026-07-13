import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";
import { requireMode } from "../middleware/access-mode.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { buildPaymentReturnUrl, resolvePurchaseContext } from "../../lib/payment-return-url.js";
import { sendSafeError } from "../lib/error-response.js";

/**
 * Content router — operator-managed read-only content the SPA renders:
 *   - FAQ articles (settings → FAQ)
 *   - Plan add-ons (purchase flow extras) + add-on checkout
 *
 * FAQ + add-on listing are public (non-sensitive, needed pre-auth) and
 * degrade to empty payloads. The add-on purchase endpoint requires an
 * authenticated session (WebSession reiwa_id or legacy Telegram).
 */
export function createContentRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore, config } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/faq?locale=ru — operator-managed FAQ items.
  // Returns `{ items: [...] }` so the SPA's existing fetch shape works.
  router.get("/faq", async (req, res) => {
    try {
      const locale =
        typeof req.query["locale"] === "string"
          ? (req.query["locale"] as string)
          : undefined;
      const items = await adminClient?.faq.getPublicFaq(locale);
      res.json({ items: items ?? [] });
    } catch {
      res.json({ items: [] });
    }
  });

  // GET /api/v1/add-ons/plan/:planId — active add-ons for a plan.
  // An upstream OUTAGE surfaces as 502 (not a masked empty catalog) so the SPA
  // can tell "no add-ons for this plan" from "backend unavailable" and show a
  // retry affordance. A NULL adminClient (not yet configured) still degrades to
  // an empty list rather than erroring.
  router.get("/add-ons/plan/:planId", async (req, res) => {
    try {
      const planId = String(req.params["planId"]);
      const addOns = await adminClient?.addOns.listForPlan(planId);
      res.json({ addOns: addOns ?? [] });
    } catch (e: unknown) {
      sendSafeError(req, res, e, 502, "Add-on catalog unavailable", "add-ons/catalog");
    }
  });

  // GET /api/v1/add-ons/subscriptions/:subscriptionId — v2 subscription-scoped
  // eligibility. Unlike the legacy plan list, an upstream OUTAGE is NOT
  // collapsed into an empty catalog: the error propagates so the client can
  // distinguish "no eligible add-ons" (availability: EMPTY) from "backend
  // unavailable". The backend remains the sole authority on eligibility/price.
  router.get(
    "/add-ons/subscriptions/:subscriptionId",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const subscriptionId = String(req.params["subscriptionId"]);
        const result = await adminClient?.addOns.listForSubscription(
          subscriptionId,
          resolveUserIdentity(req),
        );
        res.json(result ?? { contractVersion: 2, availability: "EMPTY", target: null, addOns: [] });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 502, "Add-on eligibility unavailable", "add-ons/eligibility");
      }
    },
  );

  // POST /api/v1/add-ons/purchase — checkout an add-on top-up for an
  // existing subscription. Context-aware return URLs mirror the payments
  // route (TMA deep link vs web origin).
  router.post(
    "/add-ons/purchase",
    requireSession,
    requireMode('purchase.addon'),
    async (req: AuthRequest, res) => {
      try {
        const { addOnId, subscriptionId, gatewayType, source } = (req.body ?? {}) as Record<
          string,
          unknown
        >;
        if (!addOnId || !subscriptionId || !gatewayType) {
          res.status(400).json({
            message: "addOnId, subscriptionId and gatewayType are required",
          });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const context = resolvePurchaseContext(req.context, source);
        const successUrl = buildPaymentReturnUrl({
          context,
          config,
          override: null,
        });
        const result = await adminClient?.addOns.purchase({
          identity: resolveUserIdentity(req),
          addOnId: String(addOnId),
          subscriptionId: String(subscriptionId),
          gatewayType: String(gatewayType),
          channel: context === "tma" ? "TELEGRAM" : "WEB",
          successUrl,
          failUrl: successUrl,
          expectedAddOnRevision:
            typeof body["expectedAddOnRevision"] === "number"
              ? body["expectedAddOnRevision"]
              : undefined,
          idempotencyKey:
            typeof body["idempotencyKey"] === "string" ? body["idempotencyKey"] : undefined,
          contractVersion:
            typeof body["contractVersion"] === "number" ? body["contractVersion"] : undefined,
        });
        res.json(result ?? {});
      } catch (e: unknown) {
        sendSafeError(req, res, e, 400, "Add-on purchase failed", "add-ons/purchase");
      }
    },
  );

  return router;
}
