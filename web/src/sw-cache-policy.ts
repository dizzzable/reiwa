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
