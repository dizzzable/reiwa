import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { PurchaseType } from "../../infrastructure/admin-client/namespaces/subscription.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { requireMode } from "../middleware/access-mode.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { sendSafeError } from "../lib/error-response.js";

/**
 * Flatten the rezeis nested quote shape
 * (`{ selectedPlan, selectedDuration, price: { price, currency, ... } }`,
 * prices as decimal strings) into the flat contract the SPA's
 * `SubscriptionQuote` type expects (`{ planName, durationDays, currency,
 * basePrice, finalPrice, discountPercent, ... }`). Without this the SPA
 * reads `quote.finalPrice` as `undefined` and crashes on `.toFixed`.
 *
 * Returns a `{ warning }`-only object when the upstream couldn't price the
 * selection (no matching gateway currency, plan not available, etc.) so the
 * SPA shows its "couldn't get price" state instead of blowing up.
 */
function flattenQuote(raw: unknown, requestedDurationDays: number): unknown {
  if (raw === null || typeof raw !== "object") {
    return { warning: "QUOTE_UNAVAILABLE" };
  }
  const q = raw as {
    selectedPlan?: { id?: string; name?: string } | null;
    selectedDuration?: { id?: string; days?: number } | null;
    price?: {
      gatewayType?: string;
      currency?: string;
      originalPrice?: string;
      price?: string;
      discountPercent?: number;
    } | null;
    warnings?: ReadonlyArray<{ code?: string; message?: string }>;
  };
  if (!q.price || !q.selectedPlan) {
    // No priceable selection — surface the first warning code for the SPA.
    const warning = q.warnings?.[0]?.code ?? "QUOTE_UNAVAILABLE";
    return { warning, warnings: q.warnings ?? [] };
  }
  const finalPrice = Number.parseFloat(q.price.price ?? "0");
  const basePrice = Number.parseFloat(
    q.price.originalPrice ?? q.price.price ?? "0",
  );
  return {
    planId: q.selectedPlan.id ?? null,
    planName: q.selectedPlan.name ?? "",
    durationDays: q.selectedDuration?.days ?? requestedDurationDays,
    currency: q.price.currency ?? "",
    basePrice,
    finalPrice,
    discountPercent: q.price.discountPercent ?? 0,
    gatewayType: q.price.gatewayType ?? "",
  };
}

/**
 * Flatten the rezeis action-policy shape (`{ actions: { NEW, ADDITIONAL,
 * RENEW, UPGRADE, TRIAL }, ... }`) into the flat `{ canBuy, canRenew,
 * canUpgrade, canTrial }` contract the SPA's `ActionPolicy` type expects.
 * Without this the SPA reads every `can*` flag as `undefined`, so the
 * subscription page never renders its Renew / Buy / Upgrade buttons.
 *
 * Also surfaces the multi-subscription capacity snapshot so the SPA can
 * toast "limit reached" on Buy (effective max = max(user.maxSubscriptions,
 * global defaultMaxSubscriptions when multi-sub is enabled)).
 */
function flattenActionPolicy(raw: unknown): {
  canBuy: boolean;
  canRenew: boolean;
  canUpgrade: boolean;
  canTrial: boolean;
  activeSubscriptionCount: number;
  maxSubscriptions: number;
  limitReached: boolean;
} {
  const obj =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const actions =
    obj.actions !== null && typeof obj.actions === "object"
      ? ((obj.actions as Record<string, unknown>) ?? {})
      : {};
  const flag = (key: string): boolean => actions[key] === true;
  const canBuy = flag("NEW") || flag("ADDITIONAL");
  const activeSubscriptionCount =
    typeof obj.activeSubscriptionCount === "number" &&
    Number.isFinite(obj.activeSubscriptionCount)
      ? Math.max(0, Math.floor(obj.activeSubscriptionCount))
      : 0;
  const maxSubscriptions =
    typeof obj.maxSubscriptions === "number" && Number.isFinite(obj.maxSubscriptions)
      ? Math.max(1, Math.floor(obj.maxSubscriptions))
      : 1;
  const warnings = Array.isArray(obj.warnings) ? obj.warnings : [];
  const warnedLimit = warnings.some(
    (w) =>
      w !== null &&
      typeof w === "object" &&
      (w as { code?: string }).code === "SUBSCRIPTION_LIMIT_REACHED",
  );
  // Capacity exhausted: effective max already folds per-user maxSubscriptions
  // and global multi-sub defaultMaxSubscriptions on the admin side.
  const limitReached =
    warnedLimit || activeSubscriptionCount >= maxSubscriptions;
  return {
    // A "buy" is any purchase that creates a new subscription.
    canBuy,
    canRenew: flag("RENEW"),
    canUpgrade: flag("UPGRADE"),
    canTrial: flag("TRIAL"),
    activeSubscriptionCount,
    maxSubscriptions,
    limitReached,
  };
}

export function createSubscriptionRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/subscription
  router.get("/subscription", requireSession, async (req: AuthRequest, res) => {
    try {
      const sub = await adminClient?.subscription.getActive(resolveUserIdentity(req));
      res.json(sub ?? null);
    } catch {
      res.json(null);
    }
  });

  // POST /api/v1/subscription/action-policy
  router.post(
    "/subscription/action-policy",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { subscriptionId } = (req.body ?? {}) as Record<string, unknown>;
        const policy = await adminClient?.subscription.getActionPolicy(
          resolveUserIdentity(req),
          subscriptionId !== undefined ? String(subscriptionId) : undefined,
        );
        res.json(flattenActionPolicy(policy));
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to load action policy", "subscription/action-policy");
      }
    },
  );

  // GET /api/v1/subscriptions/all — all user subscriptions (historical)
  router.get(
    "/subscriptions/all",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.subscription.getAll(resolveUserIdentity(req));
        res.json(result ?? { subscriptions: [] });
      } catch {
        res.json({ subscriptions: [] });
      }
    },
  );

  // POST /api/v1/subscription/trial — activate trial
  router.post(
    "/subscription/trial",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        if (!adminClient) {
          res.status(503).json({ message: "Service unavailable. Please retry after 30 seconds." });
          return;
        }
        const result = await adminClient.trial.activate(resolveUserIdentity(req));
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 400, "Trial activation failed", "subscription/trial");
      }
    },
  );

  // POST /api/v1/subscription/quote
  router.post(
    "/subscription/quote",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { planId, durationDays, gatewayType, purchaseType, subscriptionId } =
          (req.body ?? {}) as Record<string, unknown>;
        if (!planId || !durationDays || !gatewayType) {
          res.status(400).json({
            message: "planId, durationDays and gatewayType are required",
          });
          return;
        }
        const quote = await adminClient?.subscription.getQuote(
          resolveUserIdentity(req),
          (typeof purchaseType === "string" ? purchaseType : "NEW") as PurchaseType,
          String(planId),
          Number(durationDays),
          String(gatewayType),
          subscriptionId !== undefined ? String(subscriptionId) : undefined,
        );
        res.json(flattenQuote(quote, Number(durationDays)));
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to price the selection", "subscription/quote");
      }
    },
  );

  // POST /api/v1/subscription/renewal-options
  //
  // Lists the user's renewable subscriptions with per-item renewal
  // pricing so the SPA wizard can render the selection step (skipped
  // when there is exactly one renewable subscription). Forwards the
  // session-resolved identity, so it works for both web and Mini App.
  router.post(
    "/subscription/renewal-options",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { subscriptionIds, gatewayType, durations, plans } = (req.body ?? {}) as Record<string, unknown>;
        const context = req.context ?? "web";
        const channel = context === "tma" ? "TMA" : "WEB";
        const subscriptionIdsValid =
          Array.isArray(subscriptionIds) &&
          subscriptionIds.every((id) => typeof id === "string" && id.length > 0);
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
        const result = await adminClient?.subscription.getRenewalOptions(
          resolveUserIdentity(req),
          {
            ...(subscriptionIdsValid
              ? { subscriptionIds: subscriptionIds as readonly string[] }
              : {}),
            ...(typeof gatewayType === "string" && gatewayType.length > 0
              ? { gatewayType }
              : {}),
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
            channel,
          },
        );
        res.json(result ?? { items: [], currency: null, total: null });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to load renewal options", "subscription/renewal-options");
      }
    },
  );

  // POST /api/v1/subscription/upgrade-options
  //
  // Returns the upgrade target plans for a subscription (the plans its
  // current plan can transition to), each carrying its available durations
  // so the SPA upgrade wizard can let the user pick a target + term. Price
  // for a chosen target is fetched via the existing /subscription/quote.
  router.post(
    "/subscription/upgrade-options",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { subscriptionId, gatewayType } = (req.body ?? {}) as Record<string, unknown>;
        if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
          res.status(400).json({ message: "subscriptionId is required" });
          return;
        }
        const quote = (await adminClient?.subscription.getUpgradeOptions(
          resolveUserIdentity(req),
          subscriptionId,
          typeof gatewayType === "string" && gatewayType.length > 0 ? gatewayType : undefined,
        )) as
          | {
              availablePlans?: unknown;
              warnings?: unknown;
              selectedSubscriptionId?: unknown;
            }
          | null
          | undefined;
        res.json({
          subscriptionId,
          plans: Array.isArray(quote?.availablePlans) ? quote!.availablePlans : [],
          warnings: Array.isArray(quote?.warnings) ? quote!.warnings : [],
        });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to load upgrade options", "subscription/upgrade-options");
      }
    },
  );

  // DELETE /api/v1/subscription/:id
  //
  // Self-service deletion of one of the user's own subscriptions. Forwards the
  // session-resolved identity to rezeis-admin, which enforces ownership,
  // revokes the Remnawave profile and soft-deletes the row. Final, no refund.
  router.delete(
    "/subscription/:id",
    requireSession,
    requireMode('subscription.mutate'),
    async (req: AuthRequest, res) => {
      try {
        const subscriptionId = req.params.id;
        if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
          res.status(400).json({ message: "subscriptionId is required" });
          return;
        }
        const result = await adminClient?.subscription.deleteSubscription(
          resolveUserIdentity(req),
          subscriptionId,
        );
        res.json(result ?? { deleted: true });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to delete subscription", "subscription/delete");
      }
    },
  );

  return router;
}
