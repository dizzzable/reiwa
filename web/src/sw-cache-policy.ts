/**
 * Public API responses that are safe to retain in the service-worker cache.
 *
 * Keep this policy in a side-effect-free module so it can be regression-tested
 * without importing the service worker (which requires a browser worker
 * runtime). Frequently edited FAQ content is deliberately absent: its local
 * fallback already covers offline use, while caching successful responses can
 * hide newly attached media.
 */
export const CACHEABLE_API_EXACT = new Set<string>([
  '/api/v1/branding',
  '/api/v1/plans',
  '/api/v1/gateways',
  '/api/v1/landing',
])

const CACHEABLE_API_PREFIXES: readonly string[] = []

export function isCacheableApiPath(pathname: string): boolean {
  if (CACHEABLE_API_EXACT.has(pathname)) return true
  return CACHEABLE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/**
 * Cacheable responses the worker must still ask the NETWORK for first.
 *
 * Stale-while-revalidate answers from the cache and refreshes it behind the
 * response. That is harmless for branding and wrong for the plan catalogue,
 * the list a subscriber buys from: after an operator archives or deletes a
 * plan, the first catalogue a returning subscriber got was the old one, and the
 * panel then refused the checkout. It also defeated the cabinet's recovery from
 * that refusal, which is to refetch the catalogue — answered from the same
 * cache, the refetch could hand back the same withdrawn plan.
 *
 * Every entry stays in `CACHEABLE_API_EXACT`: the response is still stored, so
 * the catalogue keeps working offline. Only the order of asking changes.
 */
export const NETWORK_FIRST_API_EXACT = new Set<string>(['/api/v1/plans'])

export function isNetworkFirstApiPath(pathname: string): boolean {
  return NETWORK_FIRST_API_EXACT.has(pathname)
}
