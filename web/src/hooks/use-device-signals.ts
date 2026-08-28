import { useEffect, useRef } from 'react'

import { reportDeviceSignals } from '@/lib/api-client'
import { collectDeviceSignals } from '@/lib/device-signals'
import { useSession } from '@/hooks/use-session'

/**
 * Reports the browser's device signals once the cabinet knows who it is.
 *
 * ── Once per app load, and never more ────────────────────────────────────
 *
 * The signals do not change while the tab is open, so a second report would
 * only cost a round-trip and a row update. The ref is what makes that a
 * property of the hook rather than of wherever it happens to be mounted.
 *
 * ── After first paint, deliberately ──────────────────────────────────────
 *
 * Computing the hash renders a canvas and an offline audio buffer. Neither is
 * slow, but neither is anything the customer asked for, so it waits for an idle
 * moment. A person who opens the cabinet to check their subscription must never
 * pay for anti-fraud work in their first frame.
 *
 * ── Nothing here is allowed to surface ───────────────────────────────────
 *
 * A failed report loses a signal. A failed report that throws loses the
 * customer's session, and would do it for the visitors whose browsers are most
 * locked down — the very ones this exists to observe. Every path swallows.
 */
export function useDeviceSignals(): void {
  const { session, isAuthenticated } = useSession()
  const sentRef = useRef(false)

  useEffect(() => {
    if (!isAuthenticated || !session) return
    if (sentRef.current) return
    sentRef.current = true

    let cancelled = false
    const run = (): void => {
      void collectDeviceSignals()
        .then((signals) => {
          if (cancelled) return
          // Nothing computed — a hardened browser, an insecure origin, a
          // webview with no WebGL. Sending an empty report would spend a
          // request to tell the panel nothing.
          if (signals.installId === null && signals.deviceHash === null) return
          return reportDeviceSignals(signals)
        })
        .catch(() => undefined)
    }

    const idle = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      }
    ).requestIdleCallback
    // Safari has no `requestIdleCallback`; a short timeout is the same
    // intention — after the first paint, before the person navigates away.
    const handle =
      typeof idle === 'function'
        ? idle(run, { timeout: 4000 })
        : window.setTimeout(run, 1500)

    return () => {
      cancelled = true
      const cancelIdle = (window as unknown as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback
      if (typeof idle === 'function' && typeof cancelIdle === 'function') cancelIdle(handle)
      else window.clearTimeout(handle)
    }
  }, [isAuthenticated, session])
}
