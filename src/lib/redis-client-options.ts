import type { RedisOptions } from "ioredis";

/**
 * SHARED ioredis OPTIONS — every Redis client in this app is built from these.
 *
 * ── The incident these exist to prevent ──────────────────────────────────────
 *
 * 2026-08-24, production: `GET /` sat for **60006 ms** and was then aborted
 * with no status code. 60 s is not this app's limit — it is the reverse
 * proxy's `proxy_read_timeout`. Left alone, the request would have waited
 * forever. Meanwhile every `/api/v1/*` route answered 200/304 in single-digit
 * milliseconds, which is what made the failure look like a proxy problem for
 * two days: those routes serve from in-process caches, and the SPA document is
 * the one path that reads the operator's branding snapshot out of Redis.
 *
 * The stuck await was a Redis command. ioredis defaults are the whole story:
 *
 *   - `commandTimeout` is **undefined**, so a command that was written to the
 *     socket and never answered waits with no deadline at all;
 *   - `enableOfflineQueue` is **true**, so while the client believes it is
 *     reconnecting, commands pile up in memory instead of failing.
 *
 * Neither default is wrong on its own. Together, behind a socket that is
 * ESTABLISHED on our side and dead on the other — an idle connection reaped by
 * conntrack, a NAT table, or a host firewall, which is why this surfaced about
 * once a day — they turn a dead peer into an infinite wait rather than an
 * error. Nothing in the app ever saw an error to handle, because none was
 * produced.
 *
 * ── Why these values ─────────────────────────────────────────────────────────
 *
 * `commandTimeout` is the load-bearing one. Every command this app issues is a
 * small GET or SET against a Redis that is either on the same host or one hop
 * away; 2 s is far beyond any healthy round trip and far below any timeout a
 * human or a proxy is waiting on. A command that misses it has not been made
 * slow — it has been lost, and an error is the truthful answer.
 *
 * `keepAlive` decides how long a dead peer stays undetected. Without it the
 * socket inherits the OS default, which on Linux is roughly **two hours** —
 * long enough that "it fixed itself eventually" reads as unrelated to the
 * restart that seemed to fix it. 30 s means the socket is probed while the
 * connection is still idle, so the client reconnects on its own.
 *
 * `enableOfflineQueue` stays TRUE deliberately. Every client here is
 * `lazyConnect`, so the first command is issued before the connection exists;
 * with the queue off that command fails on a perfectly healthy start-up.
 * `commandTimeout` already bounds the queued case — ioredis starts the timer
 * when the command is queued, not when it reaches the wire — so the queue can
 * keep doing its job without being able to hide a dead peer forever.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

/** Socket keep-alive probe delay. See the note above on the two-hour default. */
export const REDIS_KEEPALIVE_MS = 30_000;

/**
 * Base options for `new Redis(url, ...)`. Callers spread this and add what is
 * specific to them (`lazyConnect`, key prefixes, and so on).
 */
export const REDIS_CLIENT_OPTIONS: RedisOptions = {
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  keepAlive: REDIS_KEEPALIVE_MS,
};
