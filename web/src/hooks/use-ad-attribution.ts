import { useEffect, useRef } from 'react'

import { recordAdClick } from '@/lib/api-client'
import { useSession } from '@/hooks/use-session'
import { useTelegramWebApp } from '@/hooks/use-telegram-webapp'

/** Extracts an `ad_<code>` campaign code from a raw start/campaign param. */
function parseAdCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value.startsWith('ad_')) return null
  const candidate = value.slice(3)
  return /^[A-Za-z0-9_-]{3,32}$/.test(candidate) ? candidate : null
}

/**
 * One-shot advertising attribution for the Mini App / web cabinet. When the
 * cabinet is opened via `?startapp=ad_<code>` (Telegram `start_param`) or
 * `?campaign=ad_<code>` (web), and the user is authenticated, this records a
 * single best-effort click against rezeis so the open is attributed to the
 * placement. Deduped per code via `sessionStorage` so a re-render or revisit
 * within the session never double-counts.
 */
export function useAdAttribution(): void {
  const { startParam } = useTelegramWebApp()
  const { session, isAuthenticated } = useSession()
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current) return
    if (!isAuthenticated || !session) return // wait until authenticated (edge requires a session)

    const fromQuery = new URLSearchParams(window.location.search)
    const code =
      parseAdCode(startParam) ??
      parseAdCode(fromQuery.get('campaign')) ??
      parseAdCode(fromQuery.get('startapp'))
    if (code === null) return

    const dedupeKey = `ad_click_sent_${code}`
    try {
      if (sessionStorage.getItem(dedupeKey) === '1') {
        firedRef.current = true
        return
      }
    } catch {
      /* sessionStorage unavailable (private mode) — fall through, fire once */
    }

    firedRef.current = true
    try {
      sessionStorage.setItem(dedupeKey, '1')
    } catch {
      /* ignore */
    }
    void recordAdClick(code).catch(() => {
      /* best-effort: attribution never blocks the cabinet */
    })
  }, [session, startParam, isAuthenticated])
}
