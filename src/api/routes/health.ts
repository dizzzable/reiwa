import { Router, type Request, type Response } from "express";

import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { REIWA_VERSION } from "../../core/version.js";

/**
 * Health / liveness / readiness probes — public, unauthenticated.
 *
 *   GET /api/v1/health — legacy, unconditional 200 `{status,service,version}`.
 *   GET /api/v1/live   — liveness: is THIS process alive and serving HTTP?
 *   GET /api/v1/ready  — readiness: can it serve real traffic right now?
 *
 * ── Why liveness and readiness are separate ────────────────────────────────
 * A liveness failure means "kill and restart me"; a readiness failure means
 * "stop sending me traffic until I recover". They must not check the same
 * things, because reiwa runs split across VPSes:
 *
 *   • Liveness checks NOTHING but the event loop. Any dependency probe here
 *     turns a dependency outage into a restart, and restarting reiwa cannot
 *     fix a Redis or panel outage — it only produces a crash loop that also
 *     destroys the in-memory rate-limit state and the version heartbeat.
 *
 *   • Readiness checks Redis ONLY. Redis is a hard *local* dependency: when
 *     it is gone, `createRedisRateLimiter` answers 503 on every protected
 *     route and sessions stop resolving, so the process is genuinely unable
 *     to serve — but it is co-located, so its outage is a local fault.
 *
 *   • Readiness deliberately does NOT check rezeis-admin. The panel lives on
 *     another VPS and reiwa is designed to survive its outage (cached public
 *     config, disk-mirrored branding, graceful upstream errors). Folding it
 *     into a probe would let a remote outage mark every reiwa container
 *     unhealthy — and, under any supervisor that restarts on unhealthy, turn
 *     a remote outage into a local crash loop. That is exactly the failure
 *     mode a split deployment must not have.
 *
 * ── Not an internals oracle, not a work amplifier ──────────────────────────
 * Bodies carry a status word and, for Redis, up/down/not_configured — no
 * host, latency, version or error text, so an anonymous caller learns nothing
 * it could not learn by watching 503s. The probe result is memoised for
 * `PROBE_TTL_MS`, so any request rate collapses to at most one Redis PING per
 * second, and a hung Redis is bounded by `PROBE_TIMEOUT_MS` (well inside the
 * compose healthcheck's own timeout) instead of holding the request open.
 */

/** Memoisation window for the Redis probe. Bounds cost under a request flood. */
const PROBE_TTL_MS = 1_000;
/** Hard cap on a single PING so a hung Redis can't hold the probe open. */
const PROBE_TIMEOUT_MS = 2_000;

type RedisState = "up" | "down" | "not_configured";

export function createHealthRouter(deps: {
  webSessionStore: WebSessionStore | null;
  config: ReiwaConfig;
}) {
  const { webSessionStore, config } = deps;
  const router = Router();

  let cached: { value: RedisState; at: number } | null = null;
  let inFlight: Promise<RedisState> | null = null;

  async function pingRedis(): Promise<RedisState> {
    if (!webSessionStore) return "not_configured";
    try {
      const redis = webSessionStore.getRedis();
      const pong = await Promise.race([
        redis.ping(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("redis_ping_timeout")), PROBE_TIMEOUT_MS).unref(),
        ),
      ]);
      return pong === "PONG" ? "up" : "down";
    } catch {
      return "down";
    }
  }

  async function redisState(): Promise<RedisState> {
    const now = Date.now();
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.value;
    // Collapse concurrent probes onto one PING; the healthcheck and any
    // external monitor hitting the same second must not multiply the work.
    inFlight ??= pingRedis()
      .then((value) => {
        cached = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  // Legacy probe. Unchanged shape and unconditional 200 on purpose: the panel's
  // update-checker reads `version` from here to render the Updates widget
  // (`update-checker.service.ts` → `fetchReiwaVersionFromHealth`), and it
  // discards any non-2xx response. Making this endpoint fail on a Redis outage
  // would blank the operator's version widget during the incident.
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "reiwa-api", version: REIWA_VERSION });
  });

  // Liveness — no dependency checks by design (see the header note).
  router.get("/live", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Readiness — Redis only.
  router.get("/ready", async (_req: Request, res: Response) => {
    const redis = await redisState();
    // A store that was never configured is not a runtime fault: `main.ts`
    // treats a null store as a normal boot, so readiness must not invent a
    // stricter policy than boot enforces. In production it IS a fault, because
    // there every Redis limiter answers 503 and no session can resolve — the
    // silent-but-broken state this probe exists to surface.
    const ready =
      redis === "up" ||
      (redis === "not_configured" && config.NODE_ENV !== "production");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", redis });
  });

  return router;
}
