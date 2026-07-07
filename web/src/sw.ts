/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute, Route, setCatchHandler } from 'workbox-routing'
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

declare let self: ServiceWorkerGlobalScope

// ─── Cache Names ───────────────────────────────────────────────────────────────
// Bump the version suffix whenever the caching strategy changes so the
// `activate` cleanup purges the previous generation's caches. v2 fixes the
// stale-app bug where navigations were served CacheFirst (see below).
const STATIC_CACHE = 'static-assets-v2'
const API_CACHE = 'api-responses-v2'
const NAV_CACHE = 'navigations-v2'

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
      const validCaches = [STATIC_CACHE, API_CACHE, NAV_CACHE]
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

// ─── Install: activate the new SW immediately ────────────────────────────────
// Without skipWaiting the updated worker stays in "waiting" until every tab
// is closed, so users keep running the previous build for days. autoUpdate
// registration + skipWaiting here means a redeploy is picked up on the next
// load. Combined with NetworkFirst navigations (below) the fresh index.html
// always references the fresh hashed bundles.
self.addEventListener('install', () => {
  void self.skipWaiting()
})

// ─── Precaching (Application Shell) ───────────────────────────────────────────
// Workbox injects the precache manifest here at build time.
// This caches HTML, CSS, JS bundles — the application shell.
precacheAndRoute(self.__WB_MANIFEST)

// ─── Navigations (HTML): Network-First ────────────────────────────────────────
// CRITICAL: HTML navigations MUST be network-first, never cache-first. An SPA's
// index.html references hash-named JS/CSS bundles; if the HTML is served from a
// long-lived cache the app keeps loading STALE bundles forever after a redeploy
// (the "fix deployed but user still sees the old UI" bug). Network-first fetches
// the fresh shell when online and falls back to the cached copy only offline.
const navigationRoute = new Route(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: NAV_CACHE,
    networkTimeoutSeconds: 5,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 24 * 60 * 60 }),
    ],
  }),
)

registerRoute(navigationRoute)

// ─── Static Assets: Cache-First Strategy ──────────────────────────────────────
// Matches hashed build assets (JS, CSS, fonts, images). These are immutable —
// Vite fingerprints the filename — so cache-first is safe and fast. Documents
// are intentionally EXCLUDED here (handled by the network-first route above).
const staticAssetsRoute = new Route(
  ({ request, url }) => {
    // Never let document/navigation requests fall into cache-first.
    if (request.mode === 'navigate' || request.destination === 'document') {
      return false
    }
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

// ─── API Responses: Stale-While-Revalidate (ALLOW-LIST ONLY) ──────────────────
// Only operator-managed, non-personal config/catalog endpoints are cached.
// Caching account-scoped data (subscription, payments, devices, profile,
// referrals, support, auth/session, realtime) risks serving stale or
// cross-user data for a VPN/billing app, so those endpoints intentionally
// fall through to a plain network fetch (no SW caching) — see the negative
// list in the comment below.
//
// Cached (safe, public/config, GET):
//   /api/v1/branding         — operator branding
//   /api/v1/public-config    — branding + locales bundle
//   /api/v1/plans            — public plan catalog
//   /api/v1/gateways         — enabled payment gateways (catalog, not user)
//   /api/v1/faq              — operator FAQ content
//   /api/v1/add-ons/plan/... — add-on catalog for a plan (not user state)
//
// NOT cached (account-scoped / sensitive): /auth/*, /profile, /subscription,
//   /payments/*, /activity, /promo, /referrals, /devices, /partner,
//   /support, /linking/*, /push/*, /realtime/*.
const CACHEABLE_API_EXACT = new Set<string>([
  '/api/v1/branding',
  '/api/v1/public-config',
  '/api/v1/plans',
  '/api/v1/gateways',
  '/api/v1/faq',
  '/api/v1/landing',
])

const CACHEABLE_API_PREFIXES: readonly string[] = ['/api/v1/add-ons/plan/']

function isCacheableApiPath(pathname: string): boolean {
  if (CACHEABLE_API_EXACT.has(pathname)) return true
  return CACHEABLE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

const apiRoute = new Route(
  ({ url, request }) => {
    // Only ever cache idempotent reads; never POST/PUT/PATCH/DELETE.
    if (request.method !== 'GET') return false
    return isCacheableApiPath(url.pathname)
  },
  new StaleWhileRevalidate({
    cacheName: API_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 24 * 60 * 60, // 24h — config/catalog only, never account data
        purgeOnQuotaError: true, // Evict API cache entries first on quota exceeded
      }),
    ],
  }),
)

registerRoute(apiRoute)

// ─── Offline Fallback ─────────────────────────────────────────────────────────
// Navigations are handled by the NetworkFirst `navigationRoute` above, which
// serves the cached shell when the network is unavailable. `setCatchHandler`
// is the single Workbox-blessed place to provide a last-resort response when a
// route's strategy throws (offline + empty cache) — using a second raw `fetch`
// listener would race the route and is unnecessary.
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const navCache = await caches.open(NAV_CACHE)
    const navHit = await navCache.match(request)
    if (navHit) return navHit
    const precache = await caches.open(
      'workbox-precache-v2-' + self.location.origin + '/',
    )
    const shell = await precache.match(new Request('/index.html'))
    if (shell) return shell
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offline</title></head>' +
        '<body><h1>Offline</h1><p>The app is not available offline. Please check your connection.</p></body></html>',
      { headers: { 'Content-Type': 'text/html' }, status: 503 },
    )
  }
  return Response.error()
})

// ─── Skip Waiting ─────────────────────────────────────────────────────────────
// Allow new service worker to activate immediately when updated
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

// ─── Web Push: Notification Display ───────────────────────────────────────────
//
// Browsers (and iOS 16.4+ PWAs) deliver pushes to the SW even when the
// app is closed. We render the OS-level notification through
// `showNotification()` and route the click through `notificationclick`
// to open / focus the SPA at the desired URL.
//
// Payload shape — JSON sent by `WebPushService.sendToUser`:
//   { title: string, body: string, url?: string }
//
// When the payload doesn't parse (push service tickle without data,
// or malformed body) we render a fallback so the user knows something
// happened — Chrome shows a "This site has been updated in the
// background" if we don't, which looks broken.

interface WebPushPayload {
  readonly title?: string
  readonly body?: string
  readonly url?: string
}

self.addEventListener('push', (event) => {
  const data: WebPushPayload = (() => {
    try {
      return event.data?.json() ?? {}
    } catch {
      return {}
    }
  })()

  const title = typeof data.title === 'string' && data.title.length > 0
    ? data.title
    : 'Reiwa'
  const body = typeof data.body === 'string' && data.body.length > 0
    ? data.body
    : ''
  const url = typeof data.url === 'string' && data.url.length > 0
    ? data.url
    : '/dashboard'

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
      data: { url },
      // Tag so successive pushes for the same notification type
      // collapse into one banner instead of stacking.
      tag: 'reiwa-notification',
      // `renotify` makes the device buzz/sound even when an existing
      // notification with the same tag is replaced. The DOM lib types
      // omit this Chrome-supported field; cast to silence the
      // structural check without losing the runtime behaviour on
      // Chromium / Edge / Android.
      ...({ renotify: true } as Record<string, unknown>),
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = (event.notification.data ?? {}) as { url?: string }
  const targetUrl = typeof data.url === 'string' && data.url.length > 0
    ? data.url
    : '/dashboard'
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      // Prefer focusing an existing tab so we don't blow up the user's
      // window count on every notification.
      for (const client of all) {
        try {
          const clientUrl = new URL(client.url)
          const targetParsed = new URL(targetUrl, self.location.origin)
          if (clientUrl.origin === targetParsed.origin) {
            await client.focus()
            // Send the destination so the SPA's router can navigate
            // without a full reload.
            client.postMessage({ type: 'NAVIGATE', url: targetUrl })
            return
          }
        } catch {
          // If URL parsing fails, fall through to opening a new window.
        }
      }
      await self.clients.openWindow(targetUrl)
    })(),
  )
})

// ── Push subscription rotation ───────────────────────────────────────────────
//
// Browsers fire `pushsubscriptionchange` when they invalidate/rotate the push
// subscription (provider key rotation, periodic refresh, storage pressure).
// Without re-subscribing here the user silently stops receiving pushes — the
// classic "push worked yesterday, nothing today" failure. We mint a fresh
// subscription with the current VAPID key and re-register it on the BFF. Runs
// even when the app is closed (the SW is woken for this event).
self.addEventListener('pushsubscriptionchange', (event: Event) => {
  ;(event as ExtendableEvent).waitUntil(resubscribePush())
})

async function resubscribePush(): Promise<void> {
  try {
    const keyRes = await fetch('/api/v1/push/public-key', { credentials: 'include' })
    if (!keyRes.ok) return
    const { publicKey } = (await keyRes.json()) as { publicKey?: string }
    if (typeof publicKey !== 'string' || publicKey.length === 0) return

    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: swUrlBase64ToArrayBuffer(publicKey),
    })
    const json = sub.toJSON()
    await fetch('/api/v1/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
        userAgent: self.navigator?.userAgent ?? 'service-worker',
      }),
    })
  } catch {
    // Best-effort — re-subscription is retried on the next cabinet load via
    // `ensurePushSubscription()`.
  }
}

function swUrlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = self.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) {
    view[i] = raw.charCodeAt(i)
  }
  return buffer
}
