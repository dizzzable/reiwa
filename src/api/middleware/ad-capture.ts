/**
 * Advertising capture for the web surface.
 *
 * An ad link is `https://<cabinet>/?campaign=ad_<code>`. The code arrives on a
 * plain document request — long before the visitor has a session — and the SPA
 * cannot hold on to it: the very first `navigate(..., { replace: true })` in the
 * entry page replaces the URL without its query, and the click hook only fires
 * once authenticated. The code was therefore gone by the time anything could
 * report it, so the advertising cabinet showed a literal zero for every web
 * placement (no opens, no registrations, no utm).
 *
 * This middleware makes the server the owner of the web surface:
 *   1. it records the open right away (anonymous — rezeis stores an `AdClick`
 *      with a null user), so "переход по объявлению" is counted even when the
 *      visitor never signs up;
 *   2. it parks the code in an httpOnly cookie so registration can claim
 *      first-touch attribution for the account minutes later, on a different
 *      request, with no client-side state to lose;
 *   3. it redirects to the same URL without the ad param. That keeps the code
 *      out of the SPA entirely (so a lost query string no longer matters), and
 *      it makes the client-side fallback in `use-ad-attribution` self-disabling
 *      here — the hook finds nothing to send, so one landing stays one open.
 *      Everything else in the query (`utm_*`, `ref`, …) is preserved: the
 *      register form still reads those for its registration snapshot.
 *
 * Repeat visits carrying the same code do not re-count: the incoming cookie is
 * compared first, which also blunts trivial open-inflation by refresh.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AdminClient } from '../../lib/admin-client.js';
import { getRequestLogger } from './logger-accessor.js';

/** Cookie holding the pending `ad_<code>` for the current browser. */
export const AD_CODE_COOKIE = 'ad_code';

/** Matches rezeis' tracking-code alphabet (`isValidTrackingCode`). */
const AD_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

const AD_CODE_PREFIX = 'ad_';

/** Attribution window for a parked code — long enough to sleep on a signup. */
export const AD_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Query keys that can carry an ad payload on a document request. `campaign` is
 * what `buildAdDeepLinks` emits for the web link; `startapp` shows up when a
 * Telegram deep link is pasted as a plain URL.
 */
const AD_QUERY_KEYS = ['campaign', 'startapp'] as const;

/**
 * Sub-resource `Sec-Fetch-Dest` values — an image or a script carrying an ad
 * param is never a human arriving from an ad. A DENYLIST on purpose: WKWebView
 * before Safari 16.4 (Telegram on older iPhones) sends no `Sec-Fetch-*` header
 * at all, and requiring `document` would silently stop counting those visitors.
 */
const SUBRESOURCE_DESTS = new Set([
  'image',
  'script',
  'style',
  'font',
  'iframe',
  'frame',
  'embed',
  'object',
  'audio',
  'video',
  'track',
  'manifest',
  'empty',
  'worker',
]);

/** Ingest throttle: per (ip, code), a ceiling far above any human browsing. */
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX_PER_WINDOW = 60;

/**
 * UTM tags an ad platform appends to the landing URL. `utm_term` is accepted as
 * an alias for `utm_creative` — VK and Yandex emit the former, the reports call
 * it the latter.
 */
export interface AdUtmTags {
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign?: string;
  readonly utmContent?: string;
  readonly utmCreative?: string;
}

const UTM_MAX_LENGTH = 64;

function firstString(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === 'string') : raw;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().slice(0, UTM_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads the UTM tags out of a query bag. They were never read anywhere: the
 * cabinet had a UTM breakdown that could only ever be empty, which is what the
 * first bug report about "фиксация utm-меток" was actually describing.
 */
export function parseAdUtmTags(query: Record<string, unknown>): AdUtmTags {
  const tags: Record<string, string> = {};
  const source = firstString(query['utm_source']);
  if (source !== undefined) tags['utmSource'] = source;
  const medium = firstString(query['utm_medium']);
  if (medium !== undefined) tags['utmMedium'] = medium;
  const campaign = firstString(query['utm_campaign']);
  if (campaign !== undefined) tags['utmCampaign'] = campaign;
  const content = firstString(query['utm_content']);
  if (content !== undefined) tags['utmContent'] = content;
  const creative = firstString(query['utm_creative']) ?? firstString(query['utm_term']);
  if (creative !== undefined) tags['utmCreative'] = creative;
  return tags as AdUtmTags;
}

/** Extracts the tracking code from an `ad_<code>` param value. */
export function parseAdCodeParam(raw: unknown): string | null {
  // Express gives an array when a key repeats (`?campaign=a&campaign=b`), which
  // a rewriting ad network or link shortener can easily produce. Take the first
  // value that validates in full rather than the first string, so one bad copy
  // cannot suppress a good one.
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const parsed = parseAdCodeParam(entry);
      if (parsed !== null) {
        return parsed;
      }
    }
    return null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value.startsWith(AD_CODE_PREFIX)) {
    return null;
  }
  const code = value.slice(AD_CODE_PREFIX.length);
  return AD_CODE_RE.test(code) ? code : null;
}

/** Reads the parked tracking code, if this browser carries one. */
export function readAdCodeCookie(req: Request): string | null {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[AD_CODE_COOKIE];
  return typeof raw === 'string' && AD_CODE_RE.test(raw) ? raw : null;
}

/** Drops the parked code once it has been claimed by an account. */
export function clearAdCodeCookie(res: Response): void {
  res.clearCookie(AD_CODE_COOKIE, { path: '/' });
}

/**
 * Captures `?campaign=ad_<code>` on document requests. Mount before the static
 * / SPA handlers and after `cookieParser()`.
 */
export function createAdCaptureMiddleware(deps: {
  adminClient: AdminClient | null;
  cookieSecure: boolean;
}): RequestHandler {
  // Per (ip, code) ingest ceiling. This middleware is the only unauthenticated
  // writer into `ad_clicks`, so without a ceiling a single script could invent
  // arbitrary "Открытия" and make CAC/ROAS worthless. Throttling the ingest and
  // not the response keeps a real visitor's landing working either way.
  const ingestCounters = new Map<string, { count: number; windowStart: number }>();
  function allowIngest(key: string, now: number): boolean {
    const entry = ingestCounters.get(key);
    if (entry === undefined || now - entry.windowStart >= THROTTLE_WINDOW_MS) {
      if (ingestCounters.size > 5_000) {
        for (const [staleKey, stale] of ingestCounters) {
          if (now - stale.windowStart >= THROTTLE_WINDOW_MS) {
            ingestCounters.delete(staleKey);
          }
        }
      }
      ingestCounters.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= THROTTLE_MAX_PER_WINDOW;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // Navigations only. A POST must not be redirected, and a HEAD is never a
    // person arriving from an ad.
    if (req.method !== 'GET') {
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    // An `<img src="/favicon.ico?campaign=ad_X">` on any third-party page would
    // otherwise count an open and plant a 7-day attribution cookie — cookie
    // stuffing that pays partner commission on organic signups. Bail before
    // touching the cookie or the response: leaving the strip-redirect without
    // the ingest would produce a permanent opens=0 / registrations=1 funnel.
    const dest = req.headers['sec-fetch-dest'];
    if (typeof dest === 'string' && SUBRESOURCE_DESTS.has(dest)) {
      next();
      return;
    }
    const purpose = req.headers['sec-purpose'] ?? req.headers['purpose'];
    if (typeof purpose === 'string' && purpose.includes('prefetch')) {
      next();
      return;
    }

    const query = req.query as Record<string, unknown>;
    let code: string | null = null;
    for (const key of AD_QUERY_KEYS) {
      code = parseAdCodeParam(query[key]);
      if (code !== null) {
        break;
      }
    }
    if (code === null) {
      next();
      return;
    }

    const logger = getRequestLogger(req);
    const previous = readAdCodeCookie(req);

    res.cookie(AD_CODE_COOKIE, code, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.cookieSecure,
      path: '/',
      maxAge: AD_CODE_TTL_MS,
    });

    if (previous === code) {
      // Same browser, same code — a refresh or a second visit, not a new open.
      logger.debug({ code }, 'advertising: ad code re-seen, open not re-counted');
    } else if (deps.adminClient === null) {
      logger.warn({ code }, 'advertising: ad code captured but adminClient is unavailable');
    } else if (!allowIngest(`${req.ip ?? req.socket.remoteAddress ?? 'unknown'}|${code}`, Date.now())) {
      logger.warn({ code }, 'advertising: web open ingest throttled');
    } else {
      // Anonymous open: rezeis creates the AdClick with a null user, then binds
      // the account at registration (`attributeOnly`).
      void deps.adminClient.advertising
        .recordClick({ code, surface: 'WEB', ...parseAdUtmTags(query) })
        .then(() => {
          // Logged on success too: the access log strips the query string, so
          // without this line an operator cannot tell "no ad traffic" from
          // "capture never ran" — the exact blindness that let a dead funnel
          // ship.
          logger.debug({ code, surface: 'WEB' }, 'advertising: web open captured');
        })
        .catch((err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), code },
            'advertising: anonymous open ingest failed',
          );
        });
    }

    // Strip every ad key, not just the one we matched: `?campaign=ad_A&startapp=ad_B`
    // would otherwise redirect with B still attached, and the next hop would
    // count a second open and overwrite the cookie — one visitor, two clicks,
    // attribution on the wrong placement.
    const queryStart = req.originalUrl.indexOf('?');
    const rawQuery = queryStart === -1 ? '' : req.originalUrl.slice(queryStart + 1);
    const params = new URLSearchParams(rawQuery);
    for (const key of AD_QUERY_KEYS) {
      params.delete(key);
    }
    const rest = params.toString();
    // Build the target from the parsed path, never from `originalUrl`: an
    // absolute-form request target (`GET https://evil.com/x`) leaves the host in
    // `originalUrl` but not in `req.path`, and leading `/\` is treated as `//` by
    // URL parsers. Both would turn this strip-redirect into an off-site one.
    const parsedPath = `${req.baseUrl}${req.path}`;
    const pathname = parsedPath.length === 0 ? '/' : parsedPath.replace(/^[/\\]+/, '/');
    // A cached 302 would silently stop both the ingest and the cookie for every
    // visitor behind the cache.
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Vary', 'Cookie');
    res.redirect(302, rest.length > 0 ? `${pathname}?${rest}` : pathname);
  };
}
