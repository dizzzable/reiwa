import { useEffect, useMemo, useRef } from 'react'

import { recordAdClick } from '@/lib/api-client'
import { useSession } from '@/hooks/use-session'
import { useTelegramWebApp } from '@/hooks/use-telegram-webapp'
import { readTelegramLaunchStartParam } from '@/lib/telegram-launch-params'

/** Extracts an `ad_<code>` campaign code from a raw start/campaign param. */
function parseAdCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value.startsWith('ad_')) return null
  const candidate = value.slice(3)
  return /^[A-Za-z0-9_-]{3,32}$/.test(candidate) ? candidate : null
}

/** Parked code awaiting a session, with the timestamp it was captured at. */
const PENDING_KEY = 'ad_pending_code'
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PENDING_MAX_ATTEMPTS = 3

/**
 * Server-reported reasons a later attempt could still fix. Anything else — an
 * unknown code, no identity, a plain `{ ok: true }` from an older edge — is
 * final: retrying it would either never succeed or, worse, keep succeeding and
 * record a fresh `AdClick` on every mount.
 */
const RETRYABLE_REASONS = new Set(['upstream_error', 'upstream_unavailable'])

interface PendingAd {
  readonly code: string
  readonly at: number
  readonly attempts: number
  /** UTM tags seen next to the code, parked with it so they survive the wait. */
  readonly utm?: Record<string, string>
}

const UTM_KEYS = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utm_creative', 'utmCreative'],
  ['utm_term', 'utmCreative'],
] as const

/** Reads the UTM tags from the current URL, `utm_term` aliasing `utm_creative`. */
function readUtmFromUrl(): Record<string, string> {
  const params = new URLSearchParams(window.location.search)
  const utm: Record<string, string> = {}
  for (const [queryKey, field] of UTM_KEYS) {
    const value = params.get(queryKey)?.trim().slice(0, 64)
    if (value !== undefined && value.length > 0 && utm[field] === undefined) {
      utm[field] = value
    }
  }
  return utm
}

function readPending(): PendingAd | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as {
      code?: unknown
      at?: unknown
      attempts?: unknown
      utm?: unknown
    }
    const code = parseAdCode(typeof parsed.code === 'string' ? `ad_${parsed.code}` : null)
    const at = typeof parsed.at === 'number' ? parsed.at : 0
    if (code === null || Date.now() - at > PENDING_TTL_MS) {
      localStorage.removeItem(PENDING_KEY)
      return null
    }
    const utm =
      typeof parsed.utm === 'object' && parsed.utm !== null
        ? (parsed.utm as Record<string, string>)
        : undefined
    return {
      code,
      at,
      attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
      ...(utm === undefined ? {} : { utm }),
    }
  } catch {
    return null // storage unavailable or corrupt entry
  }
}

function writePendingCode(code: string, utm: Record<string, string>): void {
  try {
    if (readPending()?.code === code) return // keep the original capture time
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        code,
        at: Date.now(),
        attempts: 0,
        ...(Object.keys(utm).length > 0 ? { utm } : {}),
      }),
    )
  } catch {
    /* private mode / quota — the server-side cookie is the primary path */
  }
}

/** Records a failed delivery and returns the new attempt count. */
function bumpAttempts(pending: PendingAd): number {
  const attempts = pending.attempts + 1
  try {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        code: pending.code,
        at: pending.at,
        attempts,
        ...(pending.utm === undefined ? {} : { utm: pending.utm }),
      }),
    )
  } catch {
    /* ignore */
  }
  return attempts
}

function clearPendingCode(): void {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Advertising attribution for the Mini App / web cabinet.
 *
 * Capture and delivery are deliberately split. A launch parameter arrives while
 * the visitor is still anonymous, and the edge redirect (`/?campaign=ad_x`) or
 * the entry page's own `navigate(..., { replace: true })` can replace the URL
 * before a session exists — so the code is parked in `localStorage` on the very
 * first render, and only sent once authenticated. Reading it straight off
 * `window.location.search` at delivery time is what made the whole web funnel
 * record nothing: by then the query string was always empty.
 *
 * On the web surface the server already owns this (see `ad-capture`): it counts
 * the open and strips the param, so the URL branch below finds nothing and one
 * landing stays one open. It still fires for the Telegram Mini App, whose
 * `start_param` travels inside `initData` and is invisible to the server, and as
 * a fallback when documents are not served through the API.
 */
export function useAdAttribution(): void {
  // Attribution only reads a launch parameter. Native activation belongs to
  // the root lifecycle, not to every dashboard mount.
  const { startParam } = useTelegramWebApp({ activate: false })
  const { session, isAuthenticated } = useSession()
  const inFlightRef = useRef(false)

  // The launch's own `start_param`, from the URL Telegram opened (or the
  // capture/mirror of it) rather than out of the bridge.
  //
  // The bridge is `window.Telegram`, which exists only after ~100 KB has been
  // fetched from telegram.org — and this product sells VPN, so the customer who
  // tapped a campaign's `t.me/…?startapp=ad_x` link has no VPN yet and that is
  // exactly the host their network blocks. Every such placement recorded
  // nothing: the bridge never arrived, and the `?startapp=` / `?campaign=`
  // fallback below cannot cover it because Telegram puts the start parameter in
  // `tgWebAppStartParam`, never in the query. Read once per mount — the launch
  // is a property of the document, not of a render.
  const launchStartParam = useMemo(() => readTelegramLaunchStartParam(), [])

  // Capture — no session gate, so the code is banked before any redirect.
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search)
    const code =
      parseAdCode(launchStartParam) ??
      parseAdCode(startParam) ??
      parseAdCode(fromQuery.get('campaign')) ??
      parseAdCode(fromQuery.get('startapp'))
    if (code === null) return
    // The tags are parked with the code: by the time a session exists the entry
    // page has usually replaced the URL, so reading them at delivery time would
    // find nothing — exactly how the code itself used to be lost.
    writePendingCode(code, readUtmFromUrl())
  }, [launchStartParam, startParam])

  // Deliver — once there is a session to attribute to.
  useEffect(() => {
    if (!isAuthenticated || !session) return // edge requires a session
    if (inFlightRef.current) return

    const pending = readPending()
    if (pending === null) return

    inFlightRef.current = true
    // No explicit surface: the edge derives MINIAPP vs WEB from the resolved
    // identity, which is more reliable than guessing from the client.
    void recordAdClick(pending.code, undefined, pending.utm)
      .then((res) => {
        // A 200 no longer means "delivered": the edge now answers
        // `recorded: false` with a reason when it could not reach rezeis. Keep
        // the parked code for those, drop it for every final outcome — this is
        // the only attribution path the Mini App has, so discarding it on a
        // transient upstream failure would lose the placement for good.
        const retryable =
          res?.recorded === false &&
          typeof res.reason === 'string' &&
          RETRYABLE_REASONS.has(res.reason)
        if (!retryable || bumpAttempts(pending) >= PENDING_MAX_ATTEMPTS) {
          clearPendingCode()
        }
      })
      .catch(() => {
        // Transport failure (offline, expired session): retry on a later mount,
        // but bounded, so a permanent 400 cannot loop forever.
        if (bumpAttempts(pending) >= PENDING_MAX_ATTEMPTS) {
          clearPendingCode()
        }
      })
      .finally(() => {
        inFlightRef.current = false
      })
  }, [session, isAuthenticated])
}
