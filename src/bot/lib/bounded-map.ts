/**
 * Sweeping for the per-user maps the bot keeps in memory.
 *
 * ── WHY THESE MAPS NEEDED IT ──────────────────────────────────────────────
 *
 * Several bot features remember something per user or per chat: who has already
 * passed the channel gate, who has recently asked AI support, whose referral
 * link was last resolved. All of them expire entries — and all of them expired
 * an entry only when that SAME key was read again.
 *
 * A user who passes the gate once and never returns therefore leaves a row
 * forever, and the maps grow with the total number of people who have ever
 * touched the bot rather than with the number currently using it. A restart
 * clears them, which is exactly why it goes unnoticed: the symptom is a process
 * that has been up for a month, not one that has just started.
 *
 * ── WHY A SWEEP AND NOT AN LRU ────────────────────────────────────────────
 *
 * What these entries hold is a DEADLINE, not a value worth keeping: an expired
 * gate pass, an old rate-limit window. Evicting by recency would throw away
 * live entries while a crowd of dead ones stayed, which for the gate means
 * re-asking somebody who passed a minute ago. Sweeping by expiry throws away
 * exactly the entries that no longer mean anything.
 *
 * The sweep is amortised: it runs on write, and only once the map is past a
 * threshold, so the ordinary path stays a single `Map.set`.
 */

/**
 * Removes entries whose deadline has passed, but only once `map` has grown
 * past `threshold`.
 *
 * `isExpired` is the caller's own staleness rule — the same one its read path
 * applies — so a swept map and an unswept one can never disagree about which
 * entries are live.
 *
 * The threshold exists so this costs nothing on a small install: below it the
 * function returns without walking anything. Above it the walk is O(size), paid
 * on one write out of many, which is cheaper than the alternative of a timer
 * this process would have to own and shut down.
 */
export function sweepExpired<K, V>(
  map: Map<K, V>,
  threshold: number,
  isExpired: (value: V) => boolean,
): void {
  if (map.size <= threshold) return;
  for (const [key, value] of map) {
    if (isExpired(value)) map.delete(key);
  }
  // STILL OVER THE LINE AFTER SWEEPING means the entries are live, not stale —
  // a genuine burst of concurrent users rather than a leak. Dropping live rows
  // here would silently turn a rate limiter into a no-op for whoever got
  // evicted, which is the one direction that must not happen quietly. The size
  // is reported instead, so an operator sees the burst rather than a mystery.
  if (map.size > threshold * 2) {
    // eslint-disable-next-line no-console
    console.warn(
      `[bounded-map] ${map.size} live entries after sweeping (threshold ${threshold}). ` +
        'These are unexpired, so this is load rather than a leak — but a map this size ' +
        'suggests the TTL is longer than the feature needs.',
    );
  }
}
