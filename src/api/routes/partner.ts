import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { sendSafeError } from "../lib/error-response.js";
import { describeUpstreamError, isUpstreamStatus } from "../lib/upstream-error.js";
import { extractSubscriptionLimitCode } from "./payments-errors.js";

export function createPartnerRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/partner/info
  router.get("/partner/info", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.partner.getInfo(resolveUserIdentity(req));
      res.json(result ?? null);
    } catch {
      res.json(null);
    }
  });

  // POST /api/v1/partner/pay — pay for a subscription with the partner balance.
  router.post("/partner/pay", requireSession, async (req: AuthRequest, res) => {
    try {
      const { purchaseType, planId, durationDays, subscriptionId, deviceType } =
        (req.body ?? {}) as Record<string, unknown>;
      if (!purchaseType || !planId || durationDays === undefined) {
        res.status(400).json({ message: "purchaseType, planId and durationDays are required" });
        return;
      }
      const channel = req.context === "tma" ? "TMA" : "WEB";
      const result = await adminClient?.payments.payWithPartnerBalance(resolveUserIdentity(req), {
        purchaseType: String(purchaseType) as "NEW" | "ADDITIONAL" | "RENEW" | "UPGRADE",
        planId: String(planId),
        durationDays: Number(durationDays),
        subscriptionId:
          typeof subscriptionId === "string" && subscriptionId.length > 0 ? subscriptionId : undefined,
        channel,
        deviceType: typeof deviceType === "string" && deviceType.length > 0 ? deviceType : undefined,
      });
      res.json(result ?? {});
    } catch (e: unknown) {
      // Same capacity gate as gateway checkout (createDraft NEW/ADDITIONAL).
      // Surface the typed code so the SPA shows "limit reached", not a generic
      // balance failure.
      if (isUpstreamStatus(e, 400)) {
        const code = extractSubscriptionLimitCode(describeUpstreamError(e).message);
        if (code === "SUBSCRIPTION_LIMIT_REACHED") {
          res.status(400).json({
            code: "SUBSCRIPTION_LIMIT_REACHED",
            message: "Subscription limit reached",
          });
          return;
        }
      }
      sendSafeError(req, res, e, 400, "Partner balance payment failed", "partner/pay");
    }
  });

  // GET /api/v1/partner/status
  // Lightweight check used by the bottom-nav to switch between the Referral
  // and Partner tab on every dashboard mount. Returns `{ isActive: false }`
  // for the vast majority of users without partner activation.
  router.get("/partner/status", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.partner.getStatus(resolveUserIdentity(req));
      res.json(result ?? { isActive: false });
    } catch {
      res.json({ isActive: false });
    }
  });

  // GET /api/v1/partner/earnings
  router.get("/partner/earnings", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.partner.getEarnings(resolveUserIdentity(req));
      res.json(result ?? { earnings: [] });
    } catch {
      res.json({ earnings: [] });
    }
  });

  // GET /api/v1/partner/referrals?page&limit — paginated referred-users list
  router.get("/partner/referrals", requireSession, async (req: AuthRequest, res) => {
    try {
      const page = Number(req.query["page"]) || 1;
      const limit = Number(req.query["limit"]) || 6;
      const result = await adminClient?.partner.getReferrals(
        resolveUserIdentity(req),
        page,
        limit,
      );
      res.json(result ?? { items: [], total: 0, page, limit });
    } catch {
      res.json({ items: [], total: 0, page: 1, limit: 6 });
    }
  });

  // GET /api/v1/partner/withdrawals
  router.get("/partner/withdrawals", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.partner.getWithdrawals(resolveUserIdentity(req));
      res.json(result ?? { withdrawals: [] });
    } catch {
      res.json({ withdrawals: [] });
    }
  });

  // POST /api/v1/partner/withdraw
  router.post("/partner/withdraw", requireSession, async (req: AuthRequest, res) => {
    try {
      const { amount, method, requisites } = (req.body ?? {}) as Record<string, unknown>;
      if (!amount || !method || !requisites) {
        res.status(400).json({ message: "amount, method and requisites are required" });
        return;
      }
      const result = await adminClient?.partner.createWithdrawal(resolveUserIdentity(req), {
        amount: Number(amount),
        method: String(method),
        requisites: String(requisites),
      });
      res.json(result ?? {});
    } catch (e: unknown) {
      sendSafeError(req, res, e, 400, "Withdrawal request failed", "partner/withdraw");
    }
  });

  // GET /api/v1/subscription/trial/eligibility
  router.get("/subscription/trial/eligibility", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.trial.getEligibility(resolveUserIdentity(req));
      res.json(result ?? { eligible: false, reason: "UNKNOWN" });
    } catch {
      res.json({ eligible: false, reason: "ERROR" });
    }
  });

  // POST /api/v1/subscription/trial
  router.post("/subscription/trial", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.trial.activate(resolveUserIdentity(req));
      res.json(result ?? {});
    } catch (e: unknown) {
      sendSafeError(req, res, e, 400, "Trial activation failed", "partner/trial");
    }
  });

  return router;
}
