/**
 * Public web-landing endpoint.
 *
 * Serves the effective PUBLISHED landing config (or the `{ enabled: false }`
 * sentinel) to unauthenticated web visitors before sign-in. Mirrors the
 * branding public route: a module-scoped cache with a 60s TTL + single-flight
 * so a burst of first-paint loads collapses onto one upstream call, plus an
 * explicit invalidate driven by the `reiwa.landing.invalidate` webhook.
 *
 * Fail-closed / never-hard-5xx: when rezeis-admin is unreachable we serve the
 * last-known-good payload; with no cache we serve the disabled sentinel so the
 * SPA simply routes `/` → `/sign-in` instead of erroring.
 */
import { Router } from "express";
import { createHash } from "node:crypto";
import type { Logger } from "pino";

import type { AdminClient } from "../../lib/admin-client.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

interface CachedLanding {
  readonly body: unknown;
  readonly etag: string;
  readonly fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const DISABLED_SENTINEL = { enabled: false } as const;

// Module-scoped so the `reiwa.landing.invalidate` webhook can drop the cache
// process-wide, making a freshly-published landing appear on the next load
// instead of waiting for the TTL.
let cached: CachedLanding | null = null;
let inflight: Promise<CachedLanding> | null = null;

/** Drop the cached landing payload. Called on the admin landing-invalidate
 *  webhook (publish/rollback) so operator changes propagate promptly. */
export function resetLandingCache(): void {
  cached = null;
  inflight = null;
}

function computeEtag(value: unknown): string {
  const hash = createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return `W/"${hash}"`;
}

async function fetchFresh(adminClient: AdminClient | null): Promise<CachedLanding> {
  if (adminClient === null) {
    return { body: DISABLED_SENTINEL, etag: computeEtag(DISABLED_SENTINEL), fetchedAt: Date.now() };
  }
  const body = await adminClient.landing.getEffective();
  const normalized = body ?? DISABLED_SENTINEL;
  return { body: normalized, etag: computeEtag(normalized), fetchedAt: Date.now() };
}

/**
 * Cached accessor (60s TTL + single-flight). On upstream failure returns the
 * last-known-good payload, or the disabled sentinel when nothing is cached —
 * the route never throws to the visitor.
 */
async function getLandingPayload(
  adminClient: AdminClient | null,
  onFailure?: (err: unknown) => void,
): Promise<CachedLanding> {
  const now = Date.now();
  if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  if (inflight === null) {
    inflight = fetchFresh(adminClient)
      .then((fresh) => {
        cached = fresh;
        inflight = null;
        return fresh;
      })
      .catch((err) => {
        inflight = null;
        onFailure?.(err);
        if (cached !== null) {
          // Extend last-known-good during the outage to reduce upstream pressure.
          cached = { ...cached, fetchedAt: Date.now() };
          return cached;
        }
        return {
          body: DISABLED_SENTINEL,
          etag: computeEtag(DISABLED_SENTINEL),
          fetchedAt: Date.now(),
        };
      });
  }
  return inflight;
}

/**
 * Effective landing body via the shared cache — used by the SPA index.html
 * handler to decide whether to inject SEO meta. Fails closed to the disabled
 * sentinel; never throws.
 */
export async function getEffectiveLandingCached(
  adminClient: AdminClient | null,
): Promise<unknown> {
  const payload = await getLandingPayload(adminClient);
  return payload.body;
}

/** HTML-attribute-escape (defensive — values come from validated config). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pick a localized string by default locale, falling back to the first value. */
function pickLocalized(text: unknown, defaultLocale: string): string | null {
  if (text === null || typeof text !== "object") return null;
  const map = text as Record<string, unknown>;
  const preferred = map[defaultLocale];
  if (typeof preferred === "string" && preferred.trim().length > 0) return preferred;
  for (const value of Object.values(map)) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Build the `<title>` + description + Open Graph / Twitter meta tags for a
 * published landing, or `null` when the module is disabled/unpublished (the
 * default app-shell meta is then served unchanged). Values are HTML-escaped.
 */
export function buildLandingMetaHead(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const config = body as Record<string, unknown>;
  if (config["enabled"] !== true) return null;
  const meta = config["meta"];
  if (meta === null || typeof meta !== "object") return null;
  const defaultLocale =
    typeof config["defaultLocale"] === "string" ? (config["defaultLocale"] as string) : "en";
  const title = pickLocalized((meta as Record<string, unknown>)["title"], defaultLocale);
  const description = pickLocalized(
    (meta as Record<string, unknown>)["description"],
    defaultLocale,
  );
  if (title === null && description === null) return null;

  const ogImage = typeof config["ogImage"] === "string" ? (config["ogImage"] as string) : null;
  const tags: string[] = [];
  if (title !== null) {
    const t = escapeHtml(title);
    tags.push(`<title>${t}</title>`);
    tags.push(`<meta property="og:title" content="${t}">`);
    tags.push(`<meta name="twitter:title" content="${t}">`);
  }
  if (description !== null) {
    const d = escapeHtml(description);
    tags.push(`<meta name="description" content="${d}">`);
    tags.push(`<meta property="og:description" content="${d}">`);
    tags.push(`<meta name="twitter:description" content="${d}">`);
  }
  tags.push(`<meta property="og:type" content="website">`);
  tags.push(`<meta name="twitter:card" content="${ogImage !== null ? "summary_large_image" : "summary"}">`);
  if (ogImage !== null) {
    tags.push(`<meta property="og:image" content="${escapeHtml(ogImage)}">`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(ogImage)}">`);
  }
  return tags.join("");
}

export function createLandingRouter(deps: {
  adminClient: AdminClient | null;
  logger?: Logger;
}) {
  const { adminClient, logger } = deps;
  const bgLog = logger?.child({ component: "landing-cache" });
  const router = Router();

  // GET /api/v1/landing — effective published landing (public, no session).
  router.get("/landing", async (req, res) => {
    try {
      const payload = await getLandingPayload(adminClient, (err) => {
        bgLog?.warn({ err }, "landing upstream fetch failed; serving fallback");
      });
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === payload.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("ETag", payload.etag);
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.json(payload.body);
    } catch (e: unknown) {
      // Defensive: getLandingPayload already fails closed, but never 5xx the
      // public route — serve the disabled sentinel so `/` → `/sign-in`.
      getRequestLogger(req).error({ err: e }, "GET /landing failed");
      res.json(DISABLED_SENTINEL);
    }
  });

  return router;
}
