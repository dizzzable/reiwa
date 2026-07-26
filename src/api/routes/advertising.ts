import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { parseAdUtmTags } from "../middleware/ad-capture.js";
import { sendSafeError } from "../lib/error-response.js";
import { describeUpstreamError } from "../lib/upstream-error.js";
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
 *   - partner self-service: list own requests, submit a request, accept
 *     counter-terms, read per-placement stats (+ tracking links).
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

  // POST /api/v1/advertising/click — Mini App / web open via ad_<code>.
  //
  // Every outcome is logged and reported back as `recorded`. This used to answer
  // a bare `{ ok: true }` on all four failure paths (bad code, no identity, no
  // adminClient, upstream error) with an empty `catch`, so a completely dead
  // funnel was indistinguishable from an idle one — which is how the web surface
  // reached production without ever recording a single click.
  router.post("/advertising/click", requireSession, async (req: AuthRequest, res) => {
    const body = (req.body ?? {}) as { code?: unknown; surface?: unknown; utm?: unknown };
    const raw = typeof body.code === "string" ? body.code.trim() : "";
    const code = raw.startsWith("ad_") ? raw.slice(3) : raw;
    const identity = resolveUserIdentity(req);
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) {
      getRequestLogger(req).warn(
        { code: raw.slice(0, 64) },
        "advertising/click ignored: malformed tracking code",
      );
      res.json({ ok: true, recorded: false, reason: "invalid_code" });
      return;
    }
    // Prefer telegramId; fall back to userId so pure web accounts can attribute.
    if (identity.telegramId === undefined && identity.userId === undefined) {
      getRequestLogger(req).warn({ code }, "advertising/click ignored: no resolvable identity");
      res.json({ ok: true, recorded: false, reason: "no_identity" });
      return;
    }
    const surfaceRaw = typeof body.surface === "string" ? body.surface.toUpperCase() : "";
    const surface =
      surfaceRaw === "MINIAPP" || surfaceRaw === "WEB" || surfaceRaw === "BOT"
        ? surfaceRaw
        : identity.telegramId !== undefined
          ? "MINIAPP"
          : "WEB";
    if (adminClient === null) {
      getRequestLogger(req).warn({ code }, "advertising/click dropped: adminClient unavailable");
      res.json({ ok: true, recorded: false, reason: "upstream_unavailable" });
      return;
    }
    // The Mini App reaches us with the tags in the body: its launch parameters
    // travel inside Telegram's `initData`, so the server never sees a URL to read
    // them from the way the web capture middleware does.
    const utm = parseAdUtmTags(
      typeof body.utm === "object" && body.utm !== null ? (body.utm as Record<string, unknown>) : {},
    );
    try {
      await adminClient.advertising.recordClick({
        code,
        telegramId: identity.telegramId ?? null,
        userId: identity.userId ?? null,
        surface,
        ...utm,
      });
    } catch (err: unknown) {
      getRequestLogger(req).warn(
        { err: describeUpstreamError(err).message, code, surface },
        "advertising/click upstream ingest failed",
      );
      res.json({ ok: true, recorded: false, reason: "upstream_error" });
      return;
    }
    res.json({ ok: true, recorded: true });
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

  // POST /api/v1/advertising/requests/:id/accept — accept operator counter-terms.
  router.post("/advertising/requests/:id/accept", requireSession, async (req: AuthRequest, res) => {
    const ref = userRef(req);
    if (ref === null) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const requestId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (requestId.length === 0) {
      res.status(400).json({ message: "request id is required" });
      return;
    }
    try {
      const result = await adminClient?.advertising.acceptPartnerRequest(ref, requestId);
      res.json(result ?? null);
    } catch (err) {
      sendSafeError(req, res, err, 502, "Failed to accept advertising request", "advertising/accept");
    }
  });

  // GET /api/v1/advertising/stats — partner per-placement stats (+ links).
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
