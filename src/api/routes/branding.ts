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

// Module-scoped so an operator branding save (relayed via the
// `reiwa.branding.invalidate` webhook) can drop the cache process-wide,
// making the new theme appear on the next cabinet load instead of waiting
// for the TTL. A single router instance is created per process.
let cached: CachedPayload | null = null;
let inflight: Promise<CachedPayload> | null = null;
let packsCache: { body: unknown; fetchedAt: number } | null = null;

/** Drop the cached public-config + custom-emoji packs. Called on the admin
 *  branding-invalidate webhook so theme edits propagate promptly. */
export function resetBrandingCache(): void {
  cached = null;
  inflight = null;
  packsCache = null;
}

/** Minimal default payload (no admin client) so the SPA / manifest can still
 *  bootstrap. Locales fall back to Russian-only. */
function defaultPublicConfig(): unknown {
  return {
    branding: {
      brandName: "Rezeis",
      logoUrl: null,
      pwaIconUrl: null,
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
}

async function fetchFreshPayload(adminClient: AdminClient | null): Promise<CachedPayload> {
  if (!adminClient) {
    const body = defaultPublicConfig();
    return { body, etag: computeEtag(body), fetchedAt: Date.now() };
  }
  const body = await adminClient.branding.getReiwaPublicConfig();
  return { body, etag: computeEtag(body), fetchedAt: Date.now() };
}

/**
 * Shared cached public-config accessor (60s TTL + stale-while-revalidate 5m).
 * Used by the SPA endpoints AND the dynamic web-manifest route so both share
 * one upstream call and one cache. `onBgFailure` lets callers log background
 * refresh failures with their own logger.
 */
export async function getPublicConfigPayload(
  adminClient: AdminClient | null,
  onBgFailure?: (err: unknown) => void,
): Promise<CachedPayload> {
  const now = Date.now();
  if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  // Stale-while-revalidate: serve stale immediately, refresh in background.
  if (cached !== null && now - cached.fetchedAt < STALE_WHILE_REVALIDATE_MS) {
    if (inflight === null) {
      inflight = fetchFreshPayload(adminClient)
        .then((fresh) => {
          cached = fresh;
          inflight = null;
          return fresh;
        })
        .catch((err) => {
          inflight = null;
          onBgFailure?.(err);
          return cached as CachedPayload;
        });
    }
    return cached;
  }
  // Cache fully expired — wait for fresh fetch (deduplicated across requests).
  if (inflight === null) {
    inflight = fetchFreshPayload(adminClient)
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

export function createBrandingRouter(deps: {
  adminClient: AdminClient | null;
  logger?: Logger;
  /**
   * Operator support handle (`BOT_SUPPORT_USERNAME`), merged into the cabinet
   * public-config so the Support page can render a "contact support on
   * Telegram" deep-link. The bot owns this env; the cabinet never sees it
   * otherwise. `null` when unset → the cabinet hides the affordance.
   */
  supportUsername?: string | null;
}) {
  const { adminClient, logger } = deps;
  const supportUsername =
    typeof deps.supportUsername === 'string' && deps.supportUsername.trim().length > 0
      ? deps.supportUsername.replace(/^@+/, '').trim()
      : null;
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

  const getPayload = (): Promise<CachedPayload> =>
    getPublicConfigPayload(adminClient, logBgFailure);

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
      // Merge the reiwa-owned support handle (env) into the cabinet config so
      // the Support page can deep-link to the Telegram support account. Done
      // per-response (not in the cached body) since it's a static env value.
      const body =
        supportUsername !== null && payload.body !== null && typeof payload.body === "object"
          ? { ...(payload.body as Record<string, unknown>), supportUsername }
          : payload.body;
      res.json(body);
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

  // GET /api/v1/custom-emoji/packs — operator custom emoji packs (cached).
  // Lets the cabinet feed render `:slug:` tokens as inline images / Lottie.
  router.get("/custom-emoji/packs", async (req, res) => {
    try {
      const now = Date.now();
      if (packsCache === null || now - packsCache.fetchedAt > CACHE_TTL_MS) {
        const packs = (await adminClient?.branding.getCustomEmojiPacks()) ?? [];
        packsCache = { body: packs, fetchedAt: now };
      }
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.json(packsCache.body);
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "GET /custom-emoji/packs failed");
      res.json([]);
    }
  });

  return router;
}

function computeEtag(value: unknown): string {
  const json = JSON.stringify(value);
  const hash = createHash("sha1").update(json).digest("hex").slice(0, 16);
  return `W/"${hash}"`;
}
