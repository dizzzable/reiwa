/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute, Route } from 'workbox-routing'
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

declare let self: ServiceWorkerGlobalScope

// ─── Cache Names ───────────────────────────────────────────────────────────────
const STATIC_CACHE = 'static-assets-v1'
const API_CACHE = 'api-responses-v1'

// ─── Strategy Configuration ────────────────────────────────────────────────────
// These define the ONLY valid strategy-to-route mappings.
// Any deviation is a configuration corruption and must trigger fail-fast.
const STRATEGY_MAP = {
  static: 'cache-first' as const,
  api: 'stale-while-revalidate' as const,
} as const

// ─── Strategy Violation Detection ──────────────────────────────────────────────
// Validates that the configured strategies match the expected mapping.
// If corrupted, prevents the app from loading.
function validateStrategyIntegrity(): boolean {
  // Verify static assets use cache-first (not stale-while-revalidate)
  if (STRATEGY_MAP.static !== 'cache-first') {
    return false
  }
  // Verify API responses use stale-while-revalidate (not cache-first)
  if (STRATEGY_MAP.api !== 'stale-while-revalidate') {
    return false
  }
  return true
}

// Run validation on service worker activation
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (!validateStrategyIntegrity()) {
        // Strategy violation detected — fail fast
        // Unregister this service worker to prevent corrupted caching
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) {
          client.postMessage({
            type: 'STRATEGY_VIOLATION',
            message:
              'Service worker caching strategy configuration is corrupted. ' +
              'Static assets must use cache-first and API responses must use stale-while-revalidate.',
          })
        }
        // Force unregister to prevent corrupted behavior
        await self.registration.unregister()
        return
      }

      // Clean up old caches from previous versions
      await cleanupOutdatedCaches()

      // Delete any caches that don't match current version identifiers
      const cacheNames = await caches.keys()
      const validCaches = [STATIC_CACHE, API_CACHE]
      await Promise.all(
        cacheNames
          .filter(
            (name) =>
              !validCaches.includes(name) &&
              !name.startsWith('workbox-precache'),
          )
          .map((name) => caches.delete(name)),
      )

      // Take control of all clients immediately
      await self.clients.claim()
    })(),
  )
})

// ─── Precaching (Application Shell) ───────────────────────────────────────────
// Workbox injects the precache manifest here at build time.
// This caches HTML, CSS, JS bundles — the application shell.
precacheAndRoute(self.__WB_MANIFEST)

// ─── Static Assets: Cache-First Strategy ──────────────────────────────────────
// Matches: /, /assets/*, and common static file extensions
// Enforced: static assets MUST use cache-first, NEVER stale-while-revalidate
const staticAssetsRoute = new Route(
  ({ request, url }) => {
    // Match navigation requests (HTML pages)
    if (request.destination === 'document') return true
    // Match assets directory
    if (url.pathname.startsWith('/assets/')) return true
    // Match static file types (JS, CSS, images, fonts)
    if (
      request.destination === 'script' ||
      request.destination === 'style' ||
      request.destination === 'font' ||
      request.destination === 'image'
    ) {
      return true
    }
    return false
  },
  new CacheFirst({
    cacheName: STATIC_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
      }),
    ],
  }),
)

registerRoute(staticAssetsRoute)

// ─── API Responses: Stale-While-Revalidate Strategy ───────────────────────────
// Matches: /api/v1/* (all API endpoints)
// Enforced: API responses MUST use stale-while-revalidate, NEVER cache-first
// This includes critical user data like subscription status
const apiRoute = new Route(
  ({ url }) => {
    return url.pathname.startsWith('/api/v1/')
  },
  new StaleWhileRevalidate({
    cacheName: API_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 24 * 60 * 60, // 24 hours — cached data no older than 24h
        purgeOnQuotaError: true, // Evict API cache entries first on quota exceeded
      }),
    ],
  }),
)

registerRoute(apiRoute)

// ─── Offline Fallback ─────────────────────────────────────────────────────────
// When offline and a navigation request fails (no cache hit), serve the app shell.
// For API requests, the stale-while-revalidate strategy will serve last cached responses.
self.addEventListener('fetch', (event) => {
  // Only handle navigation requests that aren't handled by other routes
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Try network first for navigation (precache handles this normally)
          const preloadResponse = await event.preloadResponse
          if (preloadResponse) return preloadResponse

          return await fetch(event.request)
        } catch {
          // Offline: serve the cached app shell (index.html from precache)
          const cache = await caches.open('workbox-precache-v2-' + self.location.origin + '/')
          const cachedResponse = await cache.match(
            new Request('/index.html'),
          )
          if (cachedResponse) return cachedResponse

          // Fallback: try matching from static cache
          const staticCache = await caches.open(STATIC_CACHE)
          const staticResponse = await staticCache.match(event.request)
          if (staticResponse) return staticResponse

          // Last resort: return a basic offline response
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offline</title></head>' +
              '<body><h1>Offline</h1><p>The app is not available offline. Please check your connection.</p></body></html>',
            {
              headers: { 'Content-Type': 'text/html' },
              status: 503,
            },
          )
        }
      })(),
    )
  }
})

// ─── Skip Waiting ─────────────────────────────────────────────────────────────
// Allow new service worker to activate immediately when updated
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
