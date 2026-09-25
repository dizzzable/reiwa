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
 * last-known-good payload — from memory, else the copy saved in reiwa's Redis,
 * so a restart during the outage still shows the operator's landing (W8 report
 * D2). "Disabled" comes from the panel, or from a cabinet that has never once
 * reached it: only then the sentinel, and the SPA routes `/` → `/sign-in`.
 * Every answer that is not the panel's own is served `no-store`, so no browser
 * keeps a fallback past the outage.
 */
import { Router } from "express";
import { createHash } from "node:crypto";
import type { Logger } from "pino";

import {
  CONFIG_VERSION_HEADER,
  configVersionOf,
} from "../../infrastructure/config-versions/config-version.js";
import {
  LANDING_LKG,
  LAST_KNOWN_GOOD_RETRY_MS,
  LAST_KNOWN_GOOD_UNREADABLE,
  NOOP_LAST_KNOWN_GOOD,
  type LastKnownGood,
  type LastKnownGoodStorePort,
  type LastKnownGoodUnreadable,
} from "../../infrastructure/config-versions/last-known-good.js";
import { panelOrSavedCopy } from "../../infrastructure/config-versions/panel-or-saved-copy.js";
import type { AdminClient } from "../../lib/admin-client.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

interface CachedLanding {
  readonly body: unknown;
  readonly etag: string;
  readonly fetchedAt: number;
  /** The panel answer's version; `null` for the sentinel no panel said. */
  readonly version: string | null;
  /**
   * Not a fresh panel answer: the copy kept through a failed read, the saved
   * copy, or the sentinel with nothing known. Served `no-store`.
   */
  readonly fallback: boolean;
  /**
   * The sentinel stands in for a saved copy Redis could not be read for: the
   * next failed read asks Redis again instead of extending it.
   */
  readonly savedCopyUnread?: true;
}

const CACHE_TTL_MS = 60_000;
const DISABLED_SENTINEL = { enabled: false } as const;

// Module-scoped so the `reiwa.landing.invalidate` webhook can drop the cache
// process-wide, making a freshly-published landing appear on the next load
// instead of waiting for the TTL.
let cached: CachedLanding | null = null;
let inflight: Promise<CachedLanding> | null = null;
/**
 * The read that stands in for the panel while nothing is held
 * (`panelOrSavedCopy`), joined by every request that finds the cache so: one
 * read of Redis for all of them.
 */
let coldRead: Promise<CachedLanding> | null = null;
/** Where the landing's last good copy survives a restart; set by `createLandingRouter`. */
let lastKnownGood: LastKnownGoodStorePort = NOOP_LAST_KNOWN_GOOD;
/**
 * Bumped by every reset. A read begun before the bump may not store anything —
 * its answer, the extended last-known-good, or the disabled sentinel — and may
 * clear `inflight` only while the slot still holds that read. Otherwise a read
 * that reached the panel before a publish could land after the webhook and
 * serve the old page, or `/sign-in`, for another TTL; `generation` in
 * `connect-page.ts` spells out the race.
 */
let generation = 0;

/** Drop the cached landing payload. Called on the admin landing-invalidate
 *  webhook (publish/rollback) so operator changes propagate promptly. */
export function resetLandingCache(): void {
  cached = null;
  inflight = null;
  coldRead = null;
  generation += 1;
}

/** The version of the landing held — `null` while none is — for the version poll. */
export function heldLandingVersion(): string | null {
  return cached?.version ?? null;
}

function computeEtag(value: unknown): string {
  const hash = createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return `W/"${hash}"`;
}

function sentinel(): CachedLanding {
  return {
    body: DISABLED_SENTINEL,
    etag: computeEtag(DISABLED_SENTINEL),
    fetchedAt: Date.now(),
    version: null,
    fallback: true,
  };
}

async function fetchFresh(adminClient: AdminClient | null, isCurrent: () => boolean): Promise<CachedLanding> {
  // No panel configured at all: nobody said "disabled", but there is nobody to ask.
  if (adminClient === null) return sentinel();
  const body = await adminClient.landing.getEffective();
  const normalized = body ?? DISABLED_SENTINEL;
  const version = configVersionOf(body);
  // What a restart during a panel outage serves. Only an answer no invalidation
  // overtook (see `generation`): a pre-publish read may not end up in it.
  if (isCurrent() && LANDING_LKG.accepts(normalized)) {
    void lastKnownGood.save(LANDING_LKG, normalized, version);
  }
  return { body: normalized, etag: computeEtag(normalized), fetchedAt: Date.now(), version, fallback: false };
}

/**
 * Cached accessor (60s TTL + single-flight). On upstream failure returns the
 * last-known-good payload, or the disabled sentinel when nothing is cached —
 * the route never throws to the visitor. Both outcomes land in `cached`, so a
 * panel outage costs one upstream wait per TTL window instead of one per
 * request.
 *
 * And no visitor waits out a panel that HANGS (review R3b-02, on the API side):
 *  - a landing held past its TTL — the panel's, or its copy — is served at once
 *    while one read refreshes it. The read used to be waited for: all through
 *    an outage, every visitor of one window per TTL waited the transport's ten
 *    seconds;
 *  - with nothing held — a restart, an operator's publish — or only the
 *    sentinel, the panel gets its head start, and then the copy saved in Redis
 *    is served while the read goes on (`panelOrSavedCopy`). The first visitors
 *    after a restart used to wait for the read to fail before the copy was even
 *    asked for.
 */
async function getLandingPayload(
  adminClient: AdminClient | null,
  onFailure?: (err: unknown) => void,
): Promise<CachedLanding> {
  const now = Date.now();
  const held = cached;
  if (held !== null && now - held.fetchedAt < CACHE_TTL_MS) {
    return held;
  }
  if (inflight === null) {
    const startedAt = generation;
    const pending: Promise<CachedLanding> = fetchFresh(adminClient, () => startedAt === generation)
      .then((fresh) => {
        if (startedAt === generation) cached = fresh;
        if (inflight === pending) inflight = null;
        return fresh;
      })
      .catch(async (err) => {
        if (inflight === pending) inflight = null;
        onFailure?.(err);
        if (cached !== null && cached.savedCopyUnread !== true) {
          // Extend last-known-good during the outage to reduce upstream pressure.
          const extended: CachedLanding = { ...cached, fetchedAt: Date.now(), fallback: true };
          if (startedAt === generation) cached = extended;
          return extended;
        }
        // Nothing in memory: a cold start during an outage, the case the saved
        // copy exists for. Without it this was the sentinel, and every web
        // visitor was sent to sign-in for as long as the outage lasted.
        const saved = await lastKnownGood.load(LANDING_LKG);
        // Remember the answer for the TTL. Leaving `cached` null meant the
        // failure was never recorded, so EVERY following request paid another
        // upstream timeout — with the panel on its own VPS that is ~10s per
        // visitor, indefinitely. `fetchedAt` is now, so the TTL still expires
        // and the request after it goes upstream again: the sentinel cannot
        // outlive the outage. `resetLandingCache()` still drops it at once.
        // A Redis that could not be read is not "no copy": the sentinel then
        // lives only the store's pause, and the copy is asked for again.
        const answer: CachedLanding =
          saved === null
            ? sentinel()
            : saved === LAST_KNOWN_GOOD_UNREADABLE
              ? {
                  ...sentinel(),
                  fetchedAt: Date.now() - CACHE_TTL_MS + LAST_KNOWN_GOOD_RETRY_MS,
                  savedCopyUnread: true,
                }
              : {
                  body: saved.payload,
                  etag: computeEtag(saved.payload),
                  fetchedAt: Date.now(),
                  version: saved.hash,
                  fallback: true,
                };
        if (startedAt === generation && (cached === null || cached.savedCopyUnread === true)) cached = answer;
        return answer;
      });
    inflight = pending;
  }
  const pending = inflight;
  // Past its TTL, and the panel's answer or its copy — not the sentinel, which
  // only stood in for them: served while the read above refreshes it.
  if (held !== null && held.version !== null) return held;
  if (coldRead === null) {
    const startedAt = generation;
    const read: Promise<CachedLanding> = panelOrSavedCopy({
      panel: pending,
      instead: () => savedLanding(startedAt),
    }).finally(() => {
      if (coldRead === read) coldRead = null;
    });
    coldRead = read;
  }
  return coldRead;
}

/**
 * The landing saved before this start, for `panelOrSavedCopy`: held — served
 * no-store, and replaced by the panel's answer when it lands — while nothing
 * else is held (or only the sentinel that stood in for it) and no reset came
 * since. `null` for none; "unreadable" when Redis could not say, which is never
 * held: the next read asks again.
 */
async function savedLanding(startedAt: number): Promise<CachedLanding | null | LastKnownGoodUnreadable> {
  let saved: LastKnownGood<Record<string, unknown>> | null | LastKnownGoodUnreadable;
  try {
    saved = await lastKnownGood.load(LANDING_LKG);
  } catch {
    // A store that throws despite its contract could not read either.
    return LAST_KNOWN_GOOD_UNREADABLE;
  }
  if (saved === null || saved === LAST_KNOWN_GOOD_UNREADABLE) return saved;
  const copy: CachedLanding = {
    body: saved.payload,
    etag: computeEtag(saved.payload),
    fetchedAt: Date.now(),
    version: saved.hash,
    fallback: true,
  };
  if (startedAt === generation && (cached === null || cached.version === null)) cached = copy;
  return copy;
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
  /** Where the landing's last good copy survives a restart. */
  lastKnownGood?: LastKnownGoodStorePort;
}) {
  const { adminClient, logger } = deps;
  lastKnownGood = deps.lastKnownGood ?? NOOP_LAST_KNOWN_GOOD;
  const bgLog = logger?.child({ component: "landing-cache" });
  const router = Router();

  // GET /api/v1/landing — effective published landing (public, no session).
  router.get("/landing", async (req, res) => {
    try {
      const payload = await getLandingPayload(adminClient, (err) => {
        bgLog?.warn({ err }, "landing upstream fetch failed; serving fallback");
      });
      // Which version this landing is — what `/config-versions` reports as
      // held. The service worker answers `/landing` from its cache first
      // (stale-while-revalidate), and the page's first read goes out before the
      // version watcher's first answer; the header on that cached body lets the
      // watcher see it is older and re-read it at once (review R2a-05). Set
      // before the 304: a revalidation updates the stored headers.
      if (payload.version !== null) res.setHeader(CONFIG_VERSION_HEADER, payload.version);
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === payload.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("ETag", payload.etag);
      // A fallback must NOT be cached by the browser: the sentinel parked a
      // visitor who loaded during a blip on sign-in for their next visit too.
      // The in-process cache still remembers the failure, so the panel is
      // asked only once per TTL.
      res.setHeader(
        "Cache-Control",
        payload.fallback ? "no-store" : "public, max-age=60, stale-while-revalidate=300",
      );
      res.json(payload.body);
    } catch (e: unknown) {
      // Defensive: getLandingPayload already fails closed, but never 5xx the
      // public route — serve the disabled sentinel so `/` → `/sign-in`.
      getRequestLogger(req).error({ err: e }, "GET /landing failed");
      res.setHeader("Cache-Control", "no-store");
      res.json(DISABLED_SENTINEL);
    }
  });

  return router;
}
