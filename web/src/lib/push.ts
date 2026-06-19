/**
 * Web Push helpers.
 *
 * Wraps the browser's PushManager API with a small adapter layer that
 * talks to reiwa-web's BFF. The flow is:
 *
 *   1. Fetch the VAPID public key from the BFF.
 *   2. Convert the URL-safe base64 key to a Uint8Array (the PushManager
 *      contract requires the raw bytes, not the encoded form).
 *   3. Call `pushManager.subscribe(...)` to get a `PushSubscription`
 *      from the browser's push service (FCM / Mozilla / Apple).
 *   4. POST the subscription to `/api/v1/push/subscribe` so admin can
 *      address future pushes at it.
 *
 * Compatibility:
 *   - All current Chromium browsers + Firefox + desktop Safari work.
 *   - iOS 16.4+ Safari supports web-push **only** for PWAs that have
 *     been installed to the Home Screen. The caller should hide the
 *     opt-in UI on `iOS && !standalone` mode and prompt installation
 *     instead.
 *
 * Errors are mapped to a small set of named outcomes so the UI can
 * render specific messages — generic try/catch swallows context that
 * helps the user understand why permission was denied vs. why the
 * subscription itself failed.
 */
import {
  getPushPublicKey,
  pushSubscribe,
  pushUnsubscribe,
} from '@/lib/api-client'

export type PushSupportStatus =
  | 'supported'
  | 'unsupported-browser'
  | 'unsupported-ios-not-installed'
  | 'permission-denied'

export type PushSubscribeOutcome =
  | { ok: true }
  | { ok: false; reason: PushSupportStatus | 'subscribe-failed' | 'no-public-key' }

/**
 * Quick capability probe. Run this on the settings page to decide
 * whether to show the opt-in toggle at all.
 */
export function detectPushSupport(): PushSupportStatus {
  if (typeof window === 'undefined') return 'unsupported-browser'
  const hasServiceWorker = 'serviceWorker' in navigator
  const hasPushManager = 'PushManager' in window
  const hasNotification = 'Notification' in window
  if (!hasServiceWorker || !hasPushManager || !hasNotification) {
    return 'unsupported-browser'
  }
  // iOS 16.4+ Safari supports web-push only for PWAs added to the
  // Home Screen ("standalone" display mode). Detect that case so the
  // UI can prompt installation instead of silently failing.
  const ua = navigator.userAgent
  const isIOS = /iPhone|iPad|iPod/.test(ua) && !window.matchMedia('(display-mode: standalone)').matches
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  if (isIOS && !standalone) {
    return 'unsupported-ios-not-installed'
  }
  if (Notification.permission === 'denied') {
    return 'permission-denied'
  }
  return 'supported'
}

/**
 * Are we currently subscribed? Used by the settings page to render
 * the toggle in the right state on first load.
 */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

/**
 * Request permission + subscribe. Returns a structured outcome so
 * the UI can render specific messages per failure mode.
 */
export async function subscribeToPush(): Promise<PushSubscribeOutcome> {
  const support = detectPushSupport()
  if (support !== 'supported') {
    return { ok: false, reason: support }
  }

  // 1. Request OS notification permission. This must be triggered by a
  //    user gesture or browsers reject it silently.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, reason: 'permission-denied' }
  }

  // 2. Fetch the VAPID public key. Empty string means the operator
  //    hasn't generated VAPID keys — push is configured-disabled.
  const { publicKey } = await getPushPublicKey()
  if (publicKey.length === 0) {
    return { ok: false, reason: 'no-public-key' }
  }

  // 3. Subscribe. `userVisibleOnly: true` is the only mode browsers
  //    accept — silent pushes are forbidden by all major engines.
  const reg = await navigator.serviceWorker.ready
  let subscription: PushSubscription
  try {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  } catch {
    return { ok: false, reason: 'subscribe-failed' }
  }

  // 4. Persist on the BFF. Failure here means we have a browser-side
  //    subscription that admin doesn't know about — unsubscribe locally
  //    so we can retry cleanly next time.
  try {
    const json = subscription.toJSON()
    await pushSubscribe({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
      },
      userAgent: navigator.userAgent,
    })
    return { ok: true }
  } catch {
    try {
      await subscription.unsubscribe()
    } catch {
      // best-effort
    }
    return { ok: false, reason: 'subscribe-failed' }
  }
}

/**
 * Unsubscribe locally + tell admin to drop the row.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub === null) return true
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  try {
    await pushUnsubscribe({ endpoint })
  } catch {
    // best-effort — local unsubscribe is what stops new pushes
  }
  return true
}

/**
 * Heal the push subscription on cabinet load — WITHOUT prompting.
 *
 * Web-push subscriptions silently rot: the browser rotates/drops them, or the
 * operator regenerates the VAPID keys, after which the push provider rejects
 * the old endpoint with `410 Gone` and the server prunes it — so pushes stop
 * arriving even though the cabinet still shows push as "enabled". This runs
 * only when permission is ALREADY granted and:
 *   1. re-subscribes when the browser has no subscription (it was dropped), or
 *      when the existing subscription was minted with a DIFFERENT VAPID key
 *      (operator rotated keys → old endpoint is dead), and
 *   2. re-registers the (fresh or still-valid) subscription on the BFF so a
 *      server-side prune is repaired.
 * Best-effort and idempotent: never throws into the cabinet, never prompts.
 */
export async function ensurePushSubscription(): Promise<void> {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return
  }
  if (Notification.permission !== 'granted') return
  try {
    const { publicKey } = await getPushPublicKey()
    if (publicKey.length === 0) return
    const desiredKey = urlBase64ToUint8Array(publicKey)
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    // Drop a subscription minted with a stale VAPID key — its endpoint is dead.
    if (sub !== null && !sameApplicationServerKey(sub, desiredKey)) {
      try {
        await sub.unsubscribe()
      } catch {
        // best-effort
      }
      sub = null
    }
    if (sub === null) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
    }
    const json = sub.toJSON()
    await pushSubscribe({
      endpoint: sub.endpoint,
      keys: {
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
      },
      userAgent: navigator.userAgent,
    })
  } catch {
    // Healing is best-effort — the explicit opt-in in settings remains the
    // user-facing path; we must never break the cabinet over this.
  }
}

/** True when the subscription was created with the given VAPID key bytes. */
function sameApplicationServerKey(sub: PushSubscription, desired: ArrayBuffer): boolean {
  const current = sub.options?.applicationServerKey
  if (!current) return false
  const a = new Uint8Array(current)
  const b = new Uint8Array(desired)
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Convert a URL-safe base64 string (Web Push standard form for VAPID
 * keys) to the raw bytes the browser PushManager expects.
 *
 * Implementation note: we add base64 padding here because the standard
 * form omits trailing `=` and `atob` is forgiving but we want the
 * length to be predictable — every byte position carries a single
 * curve coordinate digit. Returns a fresh ArrayBuffer (not a Uint8Array
 * view) because TypeScript 6's BufferSource discriminator distinguishes
 * SharedArrayBuffer-backed views from ArrayBuffer-backed ones, and
 * PushManager.subscribe() refuses the former.
 */
function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) {
    view[i] = raw.charCodeAt(i)
  }
  return buffer
}
