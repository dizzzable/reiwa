/**
 * A DEADLINE FOR THE SPA DOCUMENT'S HEAD LOOKUPS.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The document may WAIT for the operator's branding. It may not HANG for it.
 * `try/catch` covers a lookup that FAILS and does nothing at all for one that
 * never settles, and on 2026-08-24 production did exactly that: `GET /` sat for
 * **60006 ms** and was aborted with no status code, while every `/api/v1/*`
 * route answered 200/304 in single-digit milliseconds from its in-process
 * cache. 60 s was the reverse proxy's `proxy_read_timeout`, not a limit this
 * app holds — left alone the request would have waited forever.
 *
 * The stuck await was a Redis command with no `commandTimeout` behind a socket
 * that was ESTABLISHED on our side and dead on the other. That root cause is
 * fixed at the source in `lib/redis-client-options.ts`. This deadline is the
 * SECOND wall, and it is worth having on its own terms: the next unbounded
 * await on this path will not be that one, and the document must survive it
 * too.
 *
 * ── Why 1500 ms ─────────────────────────────────────────────────────────────
 *
 * It has to serve BOTH supported deployments, and it does:
 *
 *   - panel on the SAME host as the cabinet — the lookup answers in
 *     single-digit milliseconds and wins the race every time;
 *   - panel on its OWN VPS — still far inside a healthy round trip.
 *
 * Past that the system is not slow, it is sick, and an unbranded shell
 * delivered NOW beats a branded one delivered never.
 * `branding-provider.tsx` patches the same tags once the bundle runs, so what
 * is actually given up is the head of a document served during an outage, to a
 * visitor who still gets a working cabinet.
 *
 * ── The rule this encodes ───────────────────────────────────────────────────
 *
 * The comment beside the original fallback said "never fail a document over a
 * favicon". It was true about failure and silent about waiting, and waiting is
 * what happened. The rule is: never fail a document over a favicon, AND never
 * hang one either.
 */
export const SPA_HEAD_DEADLINE_MS = 1_500;

/**
 * Resolves with `work`'s value if it settles in time, and with `fallback`
 * otherwise — whether the work rejected or simply never answered.
 *
 * Never rejects. A caller on the document path has nothing useful to do with a
 * rejection except serve the fallback, and a rejection escaping into an
 * unawaited promise is fatal to the process by default.
 *
 * @param onDeadline Invoked only when the deadline is what settled this call.
 *   A hang produces no error to report, which is exactly why the 2026-08-24
 *   outage stayed invisible for two days — so the caller gets a chance to say
 *   something rather than nothing.
 * @param deadlineMs Overridable so tests can assert the behaviour without
 *   spending the production budget waiting for it.
 */
export function withHeadDeadline<T>(
  work: Promise<T>,
  fallback: T,
  onDeadline: () => void,
  deadlineMs: number = SPA_HEAD_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      onDeadline();
      finish(fallback);
    }, deadlineMs);
    // A pending deadline must never be the reason the process stays alive.
    timer.unref();
    void work.then(
      (value) => {
        clearTimeout(timer);
        finish(value);
      },
      () => {
        clearTimeout(timer);
        finish(fallback);
      },
    );
  });
}
