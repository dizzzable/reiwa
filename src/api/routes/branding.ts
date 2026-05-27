/**
 * Public configuration / branding endpoint.
 *
 * Serves the cached `branding + locales + defaultLocale` payload to every
 * unauthenticated SPA load. The endpoint is unauthenticated because a brand
 * name and a colour palette are public anyway — the same values are visible
 * on the rendered HTML.
 *
 * To shield rezeis-admin from a thundering-herd at SPA load time (1000 users
 * opening the Mini App at once should NOT cause 1000 upstream calls), we
 * keep an in-process cache with a 60-second TTL plus weak ETag. Most
 * loads hit the cache; updates from the admin configurator propagate within
 * ~60s without an explicit cache-bust.
 */

import { Router } from "express";
import { createHash } from "node:crypto";
import type { Logger } from "pino";

import type { AdminClient } from "../../lib/admin-client.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

interface CachedPayload {
  readonly body: unknown;
  readonly etag: string;
  readonly fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const STALE_WHILE_REVALIDATE_MS = 5 * 60_000;

export function createBrandingRouter(deps: {
  adminClient: AdminClient | null;
  logger?: Logger;
}) {
  const { adminClient, logger } = deps;
  const router = Router();

  // Background-refresh closure has no `req` in scope, so `getRequestLogger`
  // is not available there. Use the root logger when supplied (production)
  // and fall back to console for tests / supervised scripts.
  const bgLog = logger?.child({ component: "branding-cache" });
  const logBgFailure = (err: unknown): void => {
    if (bgLog) {
      bgLog.warn({ err }, "Background refresh failed; serving stale payload");
    } else {
      // eslint-disable-next-line no-console
      console.error("[branding] background refresh failed:", (err as Error).message);
    }
  };

  let cached: CachedPayload | null = null;
  let inflight: Promise<CachedPayload> | null = null;

  async function fetchFresh(): Promise<CachedPayload> {
    if (!adminClient) {
      // No admin client — return a minimal default payload so the SPA can
      // still bootstrap. Locales fall back to Russian-only.
      const body = {
        branding: {
          brandName: "Rezeis",
          logoUrl: null,
          primary: "#22c55e",
          primaryFg: "#0a0a0a",
          bgPrimary: "#0a0a0a",
          bgSecondary: "#171717",
          cardGradient: "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
          cardPattern: null,
          bgEffect: "NONE",
          borderRadius: "rounded-2xl",
          fontFamily: "Inter, system-ui, sans-serif",
        },
        locales: ["ru"],
        defaultLocale: "ru",
      };
      const etag = computeEtag(body);
      return { body, etag, fetchedAt: Date.now() };
    }
    const body = await adminClient.branding.getReiwaPublicConfig();
    const etag = computeEtag(body);
    return { body, etag, fetchedAt: Date.now() };
  }

  async function getPayload(): Promise<CachedPayload> {
    const now = Date.now();
    if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }
    // Stale-while-revalidate: serve stale immediately, refresh in background.
    if (cached !== null && now - cached.fetchedAt < STALE_WHILE_REVALIDATE_MS) {
      if (inflight === null) {
        inflight = fetchFresh()
          .then((fresh) => {
            cached = fresh;
            inflight = null;
            return fresh;
          })
          .catch((err) => {
            inflight = null;
            logBgFailure(err);
            // Return current stale value on failure.
            return cached as CachedPayload;
          });
      }
      return cached;
    }
    // Cache fully expired — wait for fresh fetch (deduplicated across concurrent requests).
    if (inflight === null) {
      inflight = fetchFresh()
        .then((fresh) => {
          cached = fresh;
          inflight = null;
          return fresh;
        })
        .catch((err) => {
          inflight = null;
          throw err;
        });
    }
    return inflight;
  }

  // GET /api/v1/public-config — full payload (branding + locales)
  router.get("/public-config", async (req, res) => {
    try {
      const payload = await getPayload();
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === payload.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("ETag", payload.etag);
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.json(payload.body);
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "GET /public-config failed");
      res.status(503).json({ message: "Configuration unavailable" });
    }
  });

  // GET /api/v1/branding — branding only (lightweight)
  router.get("/branding", async (req, res) => {
    try {
      const payload = await getPayload();
      const ifNoneMatch = req.headers["if-none-match"];
      const brandingEtag = payload.etag;
      if (ifNoneMatch === brandingEtag) {
        res.status(304).end();
        return;
      }
      const body = (payload.body as { branding: unknown }).branding;
      res.setHeader("ETag", brandingEtag);
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.json(body);
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "GET /branding failed");
      res.status(503).json({ message: "Branding unavailable" });
    }
  });

  return router;
}

function computeEtag(value: unknown): string {
  const json = JSON.stringify(value);
  const hash = createHash("sha1").update(json).digest("hex").slice(0, 16);
  return `W/"${hash}"`;
}
