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
import { configVersionOf } from "../../infrastructure/config-versions/config-version.js";
import {
  CUSTOM_EMOJI_PACKS_LKG,
  NOOP_LAST_KNOWN_GOOD,
  type LastKnownGoodStorePort,
} from "../../infrastructure/config-versions/last-known-good.js";
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
  /** The body's version (`config-version.ts`), for the version poll. */
  readonly version: string;
}

/** The custom emoji packs the feed renders, and what they are. */
export interface CachedPacks {
  readonly body: unknown;
  readonly fetchedAt: number;
  /** The panel answer's version; `null` for the empty stand-in (nothing known). */
  readonly version: string | null;
  /**
   * Not a fresh panel answer: the copy kept through a failed read, the saved
   * copy, or the empty stand-in. Served `no-store`, so no browser keeps it
   * past the outage.
   */
  readonly fallback: boolean;
}

const CACHE_TTL_MS = 60_000;
const STALE_WHILE_REVALIDATE_MS = 5 * 60_000;

// Module-scoped so an operator branding save (relayed via the
// `reiwa.branding.invalidate` webhook) can drop the cache process-wide,
// making the new theme appear on the next cabinet load instead of waiting
// for the TTL. A single router instance is created per process.
let cached: CachedPayload | null = null;
let inflight: Promise<CachedPayload> | null = null;
let packsCache: CachedPacks | null = null;
let packsInflight: Promise<CachedPacks> | null = null;
/** Where the packs' last good copy survives a restart; set by `createBrandingRouter`. */
let packsLastKnownGood: LastKnownGoodStorePort = NOOP_LAST_KNOWN_GOOD;
/**
 * Bumped by every reset. A read begun before the bump may not store its answer,
 * and may clear `inflight` only while the slot still holds that read. Otherwise
 * a read that reached the panel before the operator's save could land after the
 * webhook and serve the old theme for another TTL; `generation` in
 * `connect-page.ts` spells out the race.
 */
let generation = 0;
/** The same, for the packs: the version poll resets them on their own. */
let packsGeneration = 0;

/** Drop the cached public-config (the version poll's reset for that group alone). */
export function resetPublicConfigCache(): void {
  cached = null;
  inflight = null;
  generation += 1;
}

/** Drop the cached custom-emoji packs (the version poll's reset for that group alone). */
export function resetCustomEmojiPacksCache(): void {
  packsCache = null;
  packsInflight = null;
  packsGeneration += 1;
}

/** Drop the cached public-config + custom-emoji packs. Called on the admin
 *  branding-invalidate webhook so theme edits propagate promptly. */
export function resetBrandingCache(): void {
  resetPublicConfigCache();
  resetCustomEmojiPacksCache();
}

/** The version of the public config held — `null` while none is — for the version poll. */
export function heldPublicConfigVersion(): string | null {
  return cached?.version ?? null;
}

/** The version of the packs held — `null` while none are — for the version poll. */
export function heldCustomEmojiPacksVersion(): string | null {
  return packsCache?.version ?? null;
}

function toCachedPayload(body: PublicConfigSnapshot): CachedPayload {
  return { body, etag: computeEtag(body), fetchedAt: Date.now(), version: configVersionOf(body) };
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
  isCurrent: () => boolean,
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
  // Skipped for a read a reset has overtaken (see `generation`): the snapshot
  // is what a restart during a panel outage serves, so the pre-save theme may
  // not end up in it either.
  if (isCurrent()) {
    try {
      await persistence?.save(snapshot);
    } catch {
      // Port implementations are best-effort, but do not let a faulty test or
      // third-party adapter turn a valid upstream response into an outage.
    }
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
  isCurrent: () => boolean,
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
    return await fetchFreshPayload(adminClient, persistence, notifier, isCurrent);
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
      const startedAt = generation;
      const isCurrent = (): boolean => startedAt === generation;
      const pending: Promise<CachedPayload> = refreshPayload(adminClient, persistence, onBgFailure, notifier, isCurrent)
        .then((fresh) => {
          if (startedAt === generation) cached = fresh;
          return fresh;
        })
        .catch(() => stale)
        .finally(() => {
          if (inflight === pending) inflight = null;
        });
      inflight = pending;
    }
    return cached;
  }
  // Cache fully expired — wait for fresh fetch (deduplicated across requests).
  if (inflight === null) {
    const startedAt = generation;
    const isCurrent = (): boolean => startedAt === generation;
    const pending: Promise<CachedPayload> = refreshPayload(adminClient, persistence, onBgFailure, notifier, isCurrent)
      .then((fresh) => {
        if (startedAt === generation) cached = fresh;
        return fresh;
      })
      .finally(() => {
        if (inflight === pending) inflight = null;
      });
    inflight = pending;
  }
  return inflight;
}

/**
 * The cabinet feed's custom emoji packs (W8 report D8): 60 s TTL, served stale
 * while one refresh runs, one read at a time, and a failed read REMEMBERED for
 * the TTL — it used to be neither, so every request of a stale window fetched
 * on its own and, with the panel hanging, each one waited out the transport's
 * ten seconds. With nothing held, a failed read serves the copy saved in Redis,
 * and only with none of that the empty list, which the feed reads as "draw the
 * tokens as text".
 */
export async function getCustomEmojiPacks(adminClient: AdminClient | null): Promise<CachedPacks> {
  const held = packsCache;
  if (held !== null) {
    if (Date.now() - held.fetchedAt >= CACHE_TTL_MS && packsInflight === null) {
      void startPacksRead(adminClient);
    }
    return held;
  }
  return packsInflight ?? startPacksRead(adminClient);
}

function startPacksRead(adminClient: AdminClient | null): Promise<CachedPacks> {
  const pending: Promise<CachedPacks> = readPacks(adminClient, packsGeneration).finally(() => {
    // After a reset the slot may already hold a newer read.
    if (packsInflight === pending) packsInflight = null;
  });
  packsInflight = pending;
  return pending;
}

async function readPacks(adminClient: AdminClient | null, startedAt: number): Promise<CachedPacks> {
  try {
    if (adminClient === null) throw new Error("no panel configured");
    const packs: unknown = await adminClient.branding.getCustomEmojiPacks();
    const fresh: CachedPacks = {
      body: packs ?? [],
      fetchedAt: Date.now(),
      version: configVersionOf(packs),
      fallback: false,
    };
    // Stored — and saved as the copy a restart serves — only if no reset
    // landed meanwhile (see `generation`). The request still answers with what
    // it read.
    if (startedAt === packsGeneration) {
      packsCache = fresh;
      if (CUSTOM_EMOJI_PACKS_LKG.accepts(packs)) void packsLastKnownGood.save(CUSTOM_EMOJI_PACKS_LKG, packs);
    }
    return fresh;
  } catch {
    const held = packsCache;
    if (held !== null) {
      // Remembered: a dead panel is asked once per TTL, not once per request.
      const kept: CachedPacks = { ...held, fetchedAt: Date.now(), fallback: true };
      if (startedAt === packsGeneration) packsCache = kept;
      return kept;
    }
    const saved = await packsLastKnownGood.load(CUSTOM_EMOJI_PACKS_LKG);
    const answer: CachedPacks =
      saved !== null
        ? { body: saved.payload, fetchedAt: Date.now(), version: saved.hash, fallback: true }
        : { body: [], fetchedAt: Date.now(), version: null, fallback: true };
    if (startedAt === packsGeneration && packsCache === null) packsCache = answer;
    return answer;
  }
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
  /** Where the custom emoji packs' last good copy survives a restart. */
  lastKnownGood?: LastKnownGoodStorePort;
}) {
  const { adminClient, logger, publicConfigPersistence } = deps;
  packsLastKnownGood = deps.lastKnownGood ?? NOOP_LAST_KNOWN_GOOD;
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
      const packs = await getCustomEmojiPacks(adminClient);
      // A fallback must not be cached by the browser past the outage — the
      // connect screen's rule.
      res.setHeader(
        "Cache-Control",
        packs.fallback ? "no-store" : "public, max-age=60, stale-while-revalidate=300",
      );
      res.json(packs.body);
    } catch (e: unknown) {
      getRequestLogger(req).error({ err: e }, "GET /custom-emoji/packs failed");
      res.setHeader("Cache-Control", "no-store");
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
