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

import {
  describePublicConfigSnapshot,
  type PublicConfigPersistencePort,
  type PublicConfigSnapshot,
} from "../../application/ports/public-config-persistence.port.js";
import {
  createPublicConfigRejectionNotifier,
  type PublicConfigRejectionNotifier,
} from "../../infrastructure/public-config/rejection-notifier.js";
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

function toCachedPayload(body: PublicConfigSnapshot): CachedPayload {
  return { body, etag: computeEtag(body), fetchedAt: Date.now() };
}

/**
 * Silent fallback for callers that pass no notifier (tests, legacy callers).
 * Module-scoped so suppression state survives across calls, exactly like the
 * payload cache above.
 */
let fallbackNotifier: PublicConfigRejectionNotifier | null = null;

function resolveNotifier(
  notifier: PublicConfigRejectionNotifier | undefined,
): PublicConfigRejectionNotifier {
  if (notifier !== undefined) return notifier;
  fallbackNotifier ??= createPublicConfigRejectionNotifier({});
  return fallbackNotifier;
}

async function fetchFreshPayload(
  adminClient: AdminClient,
  persistence: PublicConfigPersistencePort | undefined,
  notifier: PublicConfigRejectionNotifier,
): Promise<CachedPayload> {
  const body: unknown = await adminClient.branding.getReiwaPublicConfig();
  const rejection = describePublicConfigSnapshot(body);
  if (rejection !== null) {
    // Name the key before throwing. The throw is caught one frame up and
    // turns into "serve the previous snapshot", which is the moment the
    // cabinet appearance freezes — without this the freeze is unattributable.
    notifier.rejected("upstream", rejection);
    throw new Error(
      `rezeis-admin returned an invalid public-config payload: ${rejection.key} (${rejection.reason}, found ${rejection.found})`,
    );
  }
  notifier.accepted("upstream");
  // A null rejection is exactly what `isPublicConfigSnapshot` asserts; re-running
  // the guard purely for the narrowing would walk the whole payload twice.
  const snapshot = body as PublicConfigSnapshot;

  // This is the only save path: the body was received from a successful
  // upstream call and passed the runtime schema guard. A persistence failure
  // is intentionally non-fatal; the fresh response is still safe to serve.
  try {
    await persistence?.save(snapshot);
  } catch {
    // Port implementations are best-effort, but do not let a faulty test or
    // third-party adapter turn a valid upstream response into an outage.
  }
  return toCachedPayload(snapshot);
}

async function loadPersistedPayload(
  persistence: PublicConfigPersistencePort | undefined,
  notifier: PublicConfigRejectionNotifier,
): Promise<CachedPayload | null> {
  if (persistence === undefined) return null;
  try {
    const snapshot = await persistence.load();
    if (snapshot === null) return null;
    // Revalidate at the route boundary even though the Redis adapter also
    // validates. This keeps injected adapters from poisoning a public route.
    const rejection = describePublicConfigSnapshot(snapshot);
    if (rejection !== null) {
      notifier.rejected("redis-load", rejection);
      return null;
    }
    return toCachedPayload(snapshot);
  } catch {
    return null;
  }
}

async function refreshPayload(
  adminClient: AdminClient | null,
  persistence: PublicConfigPersistencePort | undefined,
  onBgFailure: ((err: unknown) => void) | undefined,
  notifier: PublicConfigRejectionNotifier,
): Promise<CachedPayload> {
  // A deployment without upstream credentials may serve only an operator
  // snapshot. Returning built-in defaults with HTTP 200 would make the
  // browser persist them over its last-known-good operator theme.
  if (adminClient === null) {
    const persisted = await loadPersistedPayload(persistence, notifier);
    if (persisted !== null) return persisted;
    throw new Error("operator public-config is unavailable");
  }

  try {
    return await fetchFreshPayload(adminClient, persistence, notifier);
  } catch (err: unknown) {
    onBgFailure?.(err);
    const persisted = await loadPersistedPayload(persistence, notifier);
    if (persisted !== null) return persisted;
    throw err;
  }
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
  persistence?: PublicConfigPersistencePort,
  rejectionNotifier?: PublicConfigRejectionNotifier,
): Promise<CachedPayload> {
  const notifier = resolveNotifier(rejectionNotifier);
  const now = Date.now();
  if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  // Stale-while-revalidate: serve stale immediately, refresh in background.
  if (cached !== null && now - cached.fetchedAt < STALE_WHILE_REVALIDATE_MS) {
    if (inflight === null) {
      const stale = cached;
      inflight = refreshPayload(adminClient, persistence, onBgFailure, notifier)
        .then((fresh) => {
          cached = fresh;
          return fresh;
        })
        .catch(() => stale)
        .finally(() => {
          inflight = null;
        });
    }
    return cached;
  }
  // Cache fully expired — wait for fresh fetch (deduplicated across requests).
  if (inflight === null) {
    inflight = refreshPayload(adminClient, persistence, onBgFailure, notifier)
      .then((fresh) => {
        cached = fresh;
        return fresh;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function createBrandingRouter(deps: {
  adminClient: AdminClient | null;
  logger?: Logger;
  /** Durable last-known-good snapshot for admin-outage / restart fallback. */
  publicConfigPersistence?: PublicConfigPersistencePort;
  /**
   * Operator-visible reporting for rejected snapshots. Supplied by the
   * composition root so this router, the manifest route and the Redis adapter
   * share one suppression state; a log-only notifier is built from `logger`
   * when omitted.
   */
  publicConfigRejectionNotifier?: PublicConfigRejectionNotifier;
  /**
   * Operator support handle (`BOT_SUPPORT_USERNAME`), merged into the cabinet
   * public-config so the Support page can render a "contact support on
   * Telegram" deep-link. The bot owns this env; the cabinet never sees it
   * otherwise. `null` when unset → the cabinet hides the affordance.
   */
  supportUsername?: string | null;
  /**
   * Reiwa-owned public deep-link values. They are included in the existing
   * public-config response so rezeis-admin never has to guess them from its
   * own (admin) domain.
   */
  botUsername?: string | null;
  webBaseUrl?: string | null;
}) {
  const { adminClient, logger, publicConfigPersistence } = deps;
  const supportUsername =
    typeof deps.supportUsername === 'string' && deps.supportUsername.trim().length > 0
      ? deps.supportUsername.replace(/^@+/, '').trim()
      : null;
  const botUsername =
    typeof deps.botUsername === 'string' && deps.botUsername.trim().length > 0
      ? deps.botUsername.replace(/^@+/, '').trim()
      : null;
  const webBaseUrl =
    typeof deps.webBaseUrl === 'string' && deps.webBaseUrl.trim().length > 0
      ? deps.webBaseUrl.replace(/\/+$/, '').trim()
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

  const rejectionNotifier =
    deps.publicConfigRejectionNotifier ??
    createPublicConfigRejectionNotifier({ logger: logger ?? undefined });

  const getPayload = (): Promise<CachedPayload> =>
    getPublicConfigPayload(
      adminClient,
      logBgFailure,
      publicConfigPersistence,
      rejectionNotifier,
    );

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
        payload.body !== null && typeof payload.body === "object"
          ? {
              ...(payload.body as Record<string, unknown>),
              supportUsername,
              botUsername,
              webBaseUrl,
            }
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
