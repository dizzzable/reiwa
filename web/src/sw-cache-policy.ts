/**
 * Public API responses that are safe to retain in the service-worker cache.
 *
 * Keep this policy in a side-effect-free module so it can be regression-tested
 * without importing the service worker (which requires a browser worker
 * runtime). Frequently edited FAQ content is deliberately absent: its local
 * fallback already covers offline use, while caching successful responses can
 * hide newly attached media.
 *
 * Every entry must answer every visitor the same. The cache is keyed by URL
 * alone and shared by whoever signs in on that browser next, so a response the
 * server resolves for the caller does not belong here — however public it looks.
 * `/api/v1/plans` was the one that did not: the panel resolves the catalogue for
 * the signed-in subscriber (plans offered only to them, their personal prices),
 * and a slow network served one account's catalogue to the next. It is fetched
 * from the network every time; the cabinet cannot buy offline anyway.
 */
export const CACHEABLE_API_EXACT = new Set<string>([
  '/api/v1/branding',
  '/api/v1/gateways',
  '/api/v1/landing',
])

const CACHEABLE_API_PREFIXES: readonly string[] = []

export function isCacheableApiPath(pathname: string): boolean {
  if (CACHEABLE_API_EXACT.has(pathname)) return true
  return CACHEABLE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
