/**
 * A handle for one intended action, stable across the retries of it.
 *
 * The point is what it is NOT: a value minted per HTTP call. A double tap, a
 * dropped connection, a reload mid-request — each of those is a second call
 * for one thing the person meant to do once, and a fresh handle on each would
 * make the server treat them as separate. So the caller mints one when the
 * INTENT starts and keeps it until that intent is answered.
 */
export function createIdempotencyKey(prefix = 'act'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
