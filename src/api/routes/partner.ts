import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createSessionMiddleware, type AuthRequest } from "../middleware/session.js";

export function createPartnerRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/partner/info
  router.get("/partner/info", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.getPartnerInfo(req.telegramId!);
      res.json(result ?? null);
    } catch {
      res.json(null);
    }
  });

  // GET /api/v1/partner/status
  // Lightweight check used by the bottom-nav to switch between the Referral
  // and Partner tab on every dashboard mount. Returns `{ isActive: false }`
  // for the vast majority of users without partner activation.
  router.get("/partner/status", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.getPartnerStatus(req.telegramId!);
      res.json(result ?? { isActive: false });
    } catch {
      res.json({ isActive: false });
    }
  });

  // GET /api/v1/partner/earnings
  router.get("/partner/earnings", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.getPartnerEarnings(req.telegramId!);
      res.json(result ?? { earnings: [] });
    } catch {
      res.json({ earnings: [] });
    }
  });

  // GET /api/v1/partner/withdrawals
  router.get("/partner/withdrawals", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.getPartnerWithdrawals(req.telegramId!);
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
      const result = await adminClient?.createWithdrawal(req.telegramId!, {
        amount: Number(amount),
        method: String(method),
        requisites: String(requisites),
      });
      res.json(result ?? {});
    } catch (e: unknown) {
      res.status(400).json({ message: (e as Error).message });
    }
  });

  // GET /api/v1/subscription/trial/eligibility
  router.get("/subscription/trial/eligibility", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.getTrialEligibility(req.telegramId!);
      res.json(result ?? { eligible: false, reason: "UNKNOWN" });
    } catch {
      res.json({ eligible: false, reason: "ERROR" });
    }
  });

  // POST /api/v1/subscription/trial
  router.post("/subscription/trial", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.activateTrial(req.telegramId!);
      res.json(result ?? {});
    } catch (e: unknown) {
      res.status(400).json({ message: (e as Error).message });
    }
  });

  return router;
}
