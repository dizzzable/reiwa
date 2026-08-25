/**
 * TELLING A BLIP APART FROM A BUG.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * Production, 2026-08-25:
 *
 *   Error: getaddrinfo EAI_AGAIN rezeispanel.2get.pro
 *     at GetAddrInfoReqWrap.onlookupall (node:dns:122:26)
 *   → 500 to the subscriber, one operator alert per request
 *
 * `EAI_AGAIN` is the resolver saying, in words, "temporary failure, ask me
 * again". Nothing in this cabinet is broken when it happens, nothing the
 * operator does fixes it, and it heals by itself. Two things about the old
 * handling were wrong and they were wrong in opposite directions:
 *
 *   • the SUBSCRIBER got `500 Internal server error` — a claim that we broke,
 *     when the honest answer is that an upstream was briefly unreachable and
 *     the request is worth retrying. `503` with `Retry-After` says that, and
 *     says it in a way a client can act on;
 *
 *   • the OPERATOR got one ERROR per failed request. A thirty-second DNS blip
 *     across a busy minute is hundreds of identical alerts, and an alert
 *     repeated hundreds of times stops informing and starts burying — the same
 *     failure the `WEBHOOK_URL` hint had.
 *
 * ── Why this is not simply silenced ─────────────────────────────────────────
 *
 * Because a blip and an outage produce the SAME error. If the panel is
 * genuinely unreachable for an hour, the operator must hear about it — so this
 * throttles rather than suppresses: the first occurrence of each code reports
 * immediately, and repeats are quiet for {@link TRANSIENT_REPORT_WINDOW_MS}.
 * A one-off blip costs one line; a real outage keeps producing a line every
 * five minutes for as long as it lasts.
 */

/**
 * Failures that mean "the far end was not reachable just now".
 *
 * `ENOTFOUND` sits here with a caveat worth stating: it is also what a
 * permanently wrong hostname returns. Treating it as transient is the right
 * trade anyway — a misconfigured host produces a report every five minutes
 * forever, which is louder than the one-per-request flood it replaces and
 * still perfectly noticeable.
 */
const TRANSIENT_UPSTREAM_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  // undici's own vocabulary for the same conditions.
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** How long one transient code stays quiet after it has been reported once. */
export const TRANSIENT_REPORT_WINDOW_MS = 5 * 60_000;

/**
 * The transient code carried by `error`, or `null` when it is an ordinary bug.
 *
 * Reads `cause` as well as the error itself: a DNS failure raised inside a
 * fetch arrives wrapped, and the code that matters is one level down. Only one
 * level — deeper chains are rare here, and an unbounded walk would let an
 * unrelated transient buried under a real bug disguise it as a blip.
 */
export function transientUpstreamCode(error: unknown): string | null {
  const direct = codeOf(error);
  if (direct !== null && TRANSIENT_UPSTREAM_CODES.has(direct)) return direct;

  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  const nested = codeOf(cause);
  if (nested !== null && TRANSIENT_UPSTREAM_CODES.has(nested)) return nested;

  return null;
}

function codeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * Per-code throttle for operator reports.
 *
 * Deliberately a plain module-level map rather than a cache with eviction: the
 * key space is the fixed set above, so it cannot grow, and losing it on
 * restart is the correct behaviour — a fresh process should say something the
 * first time it sees a problem.
 */
export class TransientReportThrottle {
  private readonly lastReportedAt = new Map<string, number>();

  public constructor(private readonly windowMs: number = TRANSIENT_REPORT_WINDOW_MS) {}

  /**
   * `true` when this occurrence should reach the operator. First sighting of a
   * code always passes, so a real outage is never silent at its start.
   */
  public shouldReport(code: string, now: number = Date.now()): boolean {
    const last = this.lastReportedAt.get(code);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.lastReportedAt.set(code, now);
    return true;
  }
}
