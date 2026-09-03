/**
 * GET /api/v1/connect-page — the catalog behind the connect screen.
 *
 * Which apps the customer is offered for their platform, how to install them,
 * and what each button does. Owned and validated by the panel; the cabinet only
 * renders it.
 *
 * Cached the same way branding and the landing are: 60-second in-process TTL, a
 * weak ETag so a repeat load costs a 304, and a process-wide drop on the
 * `reiwa.connect-page.invalidate` webhook so an operator's edit shows up on the
 * next tap instead of waiting out the TTL.
 *
 * ── What happens when the panel is down ──────────────────────────────────────
 *
 * `null`, and that is a deliberate answer rather than a failure. The one thing
 * a customer always needs — the subscription link itself — belongs to the
 * cabinet, not to this payload: it is already on the screen they tapped from.
 * So a panel outage costs the app catalog and the instructions, and the screen
 * falls back to "copy the link", which is exactly what people did before this
 * screen existed. Serving a 5xx instead would turn a degraded screen into no
 * screen at all.
 */
import { Router } from "express";
import { createHash } from "node:crypto";

import type { AdminClient } from "../../infrastructure/admin-client/index.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

interface CachedCatalog {
  readonly body: unknown;
  readonly etag: string;
  readonly fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;

// Module-scoped so the invalidate webhook can drop it for the whole process.
let cached: CachedCatalog | null = null;
let inflight: Promise<CachedCatalog> | null = null;
/**
 * Bumped by every invalidate. A fetch that started before the bump may not
 * write its answer.
 *
 * Without it a slow read begun before an operator's save could land after a
 * later read that already stored the new catalog, overwrite it, and serve the
 * pre-save version for another whole TTL — with the invalidate already spent
 * and the panel reporting the event as delivered. The operator sees "the save
 * did not work" and there is nothing left to re-fire.
 */
let generation = 0;

/** Drop the cached catalog. Called from the admin invalidate webhook. */
export function resetConnectPageCache(): void {
  cached = null;
  inflight = null;
  generation += 1;
}

function computeEtag(value: unknown): string {
  const hash = createHash("sha1").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
  return `W/"${hash}"`;
}

function unavailable(): CachedCatalog {
  return { body: null, etag: computeEtag(null), fetchedAt: Date.now() };
}

async function fetchFresh(adminClient: AdminClient | null): Promise<CachedCatalog> {
  if (adminClient === null) return unavailable();
  const body = (await adminClient.connectPage.getEffective()) ?? null;
  return { body, etag: computeEtag(body), fetchedAt: Date.now() };
}

/**
 * Cached accessor: 60 s TTL, single-flight, last-known-good on failure.
 *
 * A failure is REMEMBERED for the TTL rather than left uncached. Leaving it
 * uncached is what made a panel outage cost every single visitor another
 * upstream timeout — with the panel on its own host that is seconds per tap,
 * for as long as the outage lasts.
 */
async function getCatalog(
  adminClient: AdminClient | null,
  onFailure?: (err: unknown) => void,
): Promise<CachedCatalog> {
  const now = Date.now();
  if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) return cached;

  if (inflight === null) {
    const startedAt = generation;
    inflight = fetchFresh(adminClient)
      .then((fresh) => {
        inflight = null;
        if (startedAt === generation) cached = fresh;
        return fresh;
      })
      .catch((err) => {
        inflight = null;
        // The negative cache is written FIRST. It used to be written after the
        // callback, so a throw from the logger would have undone the one thing
        // this branch exists to guarantee — that a dead panel is asked once per
        // TTL and not once per customer.
        const answer = cached !== null ? { ...cached, fetchedAt: Date.now() } : unavailable();
        if (startedAt === generation) cached = answer;
        onFailure?.(err);
        return answer;
      });
  }
  return inflight;
}

export function createConnectPageRouter(adminClient: AdminClient | null): Router {
  const router = Router();

  router.get("/connect-page", async (req, res) => {
    try {
      const payload = await getCatalog(adminClient, (err) => {
        getRequestLogger(req).warn({ err }, "connect-page upstream fetch failed; serving fallback");
      });
      if (req.headers["if-none-match"] === payload.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("ETag", payload.etag);
      // A fallback must NOT be cached publicly. `null` reads as "the screen is
      // switched off", so a thirty-second hiccup at the panel would have parked
      // every customer who loaded during it back on the external page for up to
      // five more minutes in their own browser — somewhere the invalidate
      // webhook cannot reach. The in-process cache still remembers the failure,
      // so the panel is still asked only once per TTL.
      res.setHeader(
        "Cache-Control",
        payload.body === null ? "no-store" : "public, max-age=60, stale-while-revalidate=300",
      );
      res.json(payload.body);
    } catch (e: unknown) {
      // Defensive: `getCatalog` already fails closed. Never 5xx this route —
      // the screen behind it degrades gracefully and a 5xx would not let it.
      getRequestLogger(req).error({ err: e }, "GET /connect-page failed");
      res.json(null);
    }
  });

  return router;
}
