import { lookup } from 'node:dns';

import type { Logger } from '../../infrastructure/logger/index.js';
import type { ReiwaConfig } from './app.config.js';
import { resolveRezeisAdminUrl } from './url-resolver.js';

/**
 * Boot-time warning for cross-host URLs that still point at a docker service
 * name after the stack has been split across two VPSes.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 * `REZEIS_HOST` defaults to `rezeis`, the panel's docker service name, which
 * `url-resolver.ts` turns into `http://rezeis:8000`. That is *correct* on a
 * single host, where the panel is a container on the shared
 * `remnawave-network`, and *dead* on a split deploy, where the name resolves to
 * nothing. The failure is quiet in the worst way: every business call fails DNS,
 * the cabinet answers 503, and the panel's own log stays empty because the
 * requests never reached it — so the operator debugs the wrong machine.
 *
 * ── Why this cannot be decided from the config alone ─────────────────────────
 * Nothing in reiwa's environment states which topology it is in. `REIWA_DOMAIN`
 * is a public domain in both, so it is not evidence. A purely static rule —
 * "warn when the host has no dot" — would fire on every correct single-host
 * install, and a warning that cries wolf is worse than no warning at all. Adding
 * an env var to declare the topology is not an option either: it would be one
 * more thing to set wrong, and it would be wrong silently.
 *
 * ── The signal actually used ─────────────────────────────────────────────────
 * DNS resolution of the hostname, from inside this process. It tests the thing
 * that matters instead of guessing the topology:
 *
 *   • correct single-host install — the panel is a container on the shared
 *     network, so `rezeis` resolves. That is exactly what makes the install
 *     correct, so this check is silent by construction.
 *   • split-VPS install with the default left in place — the name does not exist
 *     here, resolution returns NXDOMAIN, and the warning fires.
 *
 * Four independent conditions must all hold before anything is printed, each one
 * removing a class of false positive:
 *
 *   1. `NODE_ENV === 'production'`.
 *   2. The hostname is *bare*: no dot, not an IP literal, not `localhost`. A
 *      real domain that is merely down is a different problem, and this check
 *      says nothing about it.
 *   3. The upstream is actually in use (`REZEIS_TOKEN` is set — without it the
 *      AdminClient is never constructed and reiwa runs degraded on purpose).
 *   4. The lookup fails with a definitive "no such name", and keeps failing
 *      across three attempts spread over five minutes. This absorbs the one real
 *      false positive: two independent compose stacks on the same host started
 *      minutes apart, where the peer container simply is not up yet. A transient
 *      resolver failure (EAI_AGAIN) is never reported.
 *
 * The check never blocks the boot. Refusing to start would break every existing
 * single-host install, and a warning naming the variable and the consequence is
 * what the operator needs anyway.
 *
 * Deliberately NOT checked: `REIWA_BOT_INTERNAL_URL` (default
 * `http://reiwa-bot:5100`) and `REDIS_HOST`. Those name containers in reiwa's own
 * compose file and stay docker service names on both topologies, so a dotless
 * value there is right, not suspicious.
 */

/** Delay before each attempt, measured from the previous one (cumulative 30s / 2min / 5min). */
const PROBE_DELAYS_MS: readonly number[] = [30_000, 90_000, 180_000];

/** Name resolution, injectable so the tests do not depend on real DNS. */
export type LookupFn = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null) => void,
) => void;

/** Test seam only. Production calls pass nothing and get the real DNS + delays. */
export interface CrossHostCheckDeps {
  readonly lookup?: LookupFn;
  readonly delaysMs?: readonly number[];
}

/**
 * Schedules the probe and returns immediately. Safe to call unconditionally: it
 * no-ops outside production and can never throw into the boot path.
 */
export function warnOnUnreachableCrossHostUrls(
  config: ReiwaConfig,
  logger: Logger,
  deps: CrossHostCheckDeps = {},
): void {
  try {
    if (config.NODE_ENV !== 'production') return;
    if (!config.REZEIS_TOKEN) return;

    const adminUrl = resolveRezeisAdminUrl(config);
    if (adminUrl === null) return;

    const hostname = bareServiceHostname(adminUrl);
    if (hostname === null) return;

    scheduleProbe({
      hostname,
      adminUrl,
      logger,
      resolveName: deps.lookup ?? defaultLookup,
      delays: deps.delaysMs ?? PROBE_DELAYS_MS,
    });
  } catch {
    /* A diagnostic must never be the reason reiwa fails to start. */
  }
}

/**
 * `lookup` (not `resolve`) on purpose: it goes through getaddrinfo, so it sees
 * docker's embedded DNS and /etc/hosts exactly the way undici will.
 */
const defaultLookup: LookupFn = (hostname, callback) => {
  lookup(hostname, (error) => callback(error));
};

/**
 * Returns the hostname when it is a bare service name, `null` otherwise.
 *
 * A dot means a DNS name or an IPv4 literal; a colon or bracket means IPv6. Both
 * are things the operator addressed on purpose, and neither is the mistake this
 * check is looking for. (`url-resolver.ts` classifies hosts the same way before
 * choosing http vs https.)
 */
function bareServiceHostname(value: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return null;
  }
  if (hostname.length === 0) return null;
  if (hostname.includes('.') || hostname.includes(':') || hostname.includes('[')) return null;
  if (hostname.toLowerCase() === 'localhost') return null;
  return hostname;
}

function scheduleProbe(input: {
  readonly hostname: string;
  readonly adminUrl: string;
  readonly logger: Logger;
  readonly resolveName: LookupFn;
  readonly delays: readonly number[];
}): void {
  const { hostname, adminUrl, logger, resolveName, delays } = input;
  const attempt = (index: number): void => {
    const timer = setTimeout(() => {
      resolveName(hostname, (error: NodeJS.ErrnoException | null) => {
        if (error === null || !isNameNotFound(error)) {
          // Either the name resolves — a correct single-host install, nothing to
          // say — or the resolver itself is unhappy. In neither case have we
          // learned that the value is wrong, so stay quiet and stop probing.
          return;
        }
        const next = index + 1;
        if (next < delays.length) {
          attempt(next);
          return;
        }
        logger.warn(
          { variable: 'REZEIS_HOST', hostname, resolvedUrl: adminUrl },
          `REZEIS_HOST="${hostname}" is a bare hostname that does not resolve from this host ` +
            '(DNS: no such name, still failing after 5 minutes), so every call to rezeis-admin ' +
            `would go to ${adminUrl} and fail. That is the single-host default, where it names ` +
            'the panel container on the shared docker network. On a split-VPS deploy REZEIS_HOST ' +
            "must be the panel's PUBLIC domain (e.g. panel.example.com). Until it is fixed the " +
            "cabinet answers 503 and the panel's log stays empty, because the requests never " +
            'reach it.',
        );
      });
    }, delays[index]);
    // Never hold the process open for a diagnostic.
    timer.unref();
  };
  attempt(0);
}

/**
 * True only for a definitive "this name does not exist". `EAI_AGAIN` is a
 * temporary resolver failure and is deliberately excluded — reporting it would
 * turn a blip in docker's DNS into an accusation about the operator's config.
 */
function isNameNotFound(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOTFOUND' || error.code === 'ENODATA' || error.code === 'EAI_NODATA';
}
