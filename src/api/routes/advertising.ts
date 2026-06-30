import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { sendSafeError } from "../lib/error-response.js";
import type { AdPlatform } from "../../infrastructure/admin-client/namespaces/advertising.js";

const PLATFORMS: readonly AdPlatform[] = [
  "TELEGRAM",
  "TELEGRAM_ADS",
  "YOUTUBE",
  "TIKTOK",
  "INSTAGRAM",
  "VK",
  "WEBSITE",
  "INFLUENCER",
  "OTHER",
];

/**
 * Cabinet-facing advertising routes:
 *   - `POST /advertising/click` records a Mini-App / web open carrying an
 *     `ad_<code>` campaign param (best-effort, fire-and-forget).
 *   - partner self-service: list own requests, submit a request, read per-
 *     placement stats. All proxy to the rezeis internal advertising API.
 */
export function createAdvertisingRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  function userRef(req: AuthRequest): string | null {
    const identity = resolveUserIdentity(req);
    return identity.telegramId ?? identity.userId ?? null;
  }

  // POST /api/v1/advertising/click — Mini-App / web open via ad_<code>.
  router.post("/advertising/click", requireSession, async (req: AuthRequest, res) => {
    const body = (req.body ?? {}) as { code?: unknown };
    const raw = typeof body.code === "string" ? body.code.trim() : "";
    const code = raw.startsWith("ad_") ? raw.slice(3) : raw;
    const identity = resolveUserIdentity(req);
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(code) || identity.telegramId === undefined) {
      // Nothing to attribute (no code or no Telegram id) — succeed quietly.
      res.json({ ok: true });
      return;
    }
    try {
      await adminClient?.advertising.recordClick({ code, telegramId: identity.telegramId });
    } catch {
      /* best-effort */
    }
    res.json({ ok: true });
  });

  // GET /api/v1/advertising/requests — partner's own requests.
  router.get("/advertising/requests", requireSession, async (req: AuthRequest, res) => {
    const ref = userRef(req);
    if (ref === null) {
      res.json({ requests: [] });
      return;
    }
    try {
      res.json((await adminClient?.advertising.listPartnerRequests(ref)) ?? { requests: [] });
    } catch {
      res.json({ requests: [] });
    }
  });

  // POST /api/v1/advertising/requests — submit a partner ad request.
  router.post("/advertising/requests", requireSession, async (req: AuthRequest, res) => {
    const ref = userRef(req);
    if (ref === null) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as {
      platforms?: unknown;
      channel?: unknown;
      notes?: unknown;
      proposedWindowDays?: unknown;
      selfFundedBudgetNote?: unknown;
    };
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((p): p is AdPlatform => PLATFORMS.includes(p as AdPlatform))
      : [];
    const proposedWindowDays = Number(body.proposedWindowDays);
    if (platforms.length === 0 || !Number.isFinite(proposedWindowDays)) {
      res.status(400).json({ message: "platforms and proposedWindowDays are required" });
      return;
    }
    try {
      const result = await adminClient?.advertising.createPartnerRequest(ref, {
        platforms,
        channel: typeof body.channel === "string" ? body.channel : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        proposedWindowDays: Math.max(1, Math.min(365, proposedWindowDays)),
        selfFundedBudgetNote:
          typeof body.selfFundedBudgetNote === "string" ? body.selfFundedBudgetNote : undefined,
      });
      res.json(result ?? null);
    } catch (err) {
      sendSafeError(req, res, err, 502, "Failed to submit advertising request", "advertising/requests");
    }
  });

  // GET /api/v1/advertising/stats — partner per-placement stats.
  router.get("/advertising/stats", requireSession, async (req: AuthRequest, res) => {
    const ref = userRef(req);
    if (ref === null) {
      res.json({ placements: [] });
      return;
    }
    try {
      res.json((await adminClient?.advertising.getPartnerStats(ref)) ?? { placements: [] });
    } catch {
      res.json({ placements: [] });
    }
  });

  return router;
}
