import { useEffect } from 'react'
import { useNavigate } from 'react-router'

import { detectTelegramInitData } from './telegram-launch'

/**
 * ContextRouter — fallback hub at `/bootstrap`.
 *
 * Historically `/bootstrap` was the single TMA entry point that browser
 * users ended up on through the catch-all redirect. It now plays a
 * smaller role: detect the runtime context once, and forward to the
 * dedicated entry route.
 *
 *  - `Telegram.WebApp.initData` non-empty → redirect to `/tma`
 *    (which performs the actual Telegram auth handshake).
 *  - Otherwise → redirect to `/` (web home), which probes the session
 *    cookie and either lands the user on `/dashboard` or `/sign-in`.
 *
 * Kept around so legacy deep-links (`?start=` parameter that opens the
 * Mini App on this path, e.g. payment-return URLs from older builds)
 * still work without forcing operators to update bot configuration.
 *
 * The detection used to read `window.Telegram` synchronously on mount, which
 * is a guess, not a reading: the SDK arrives from telegram.org well after
 * mount. Being wrong here is not self-correcting — the fallback `/` is a
 * react-router navigation, and that drops the URL hash carrying Telegram's
 * launch parameters, so the root page would then see a plain browser too and
 * send a Mini App user to the login form. Hence the shared wait.
 */
export default function ContextRouter() {
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false

    // Preserve an intended deep-link destination (`?next=`) across the
    // context hop so Mini App deep-links survive the bootstrap redirect.
    const search = typeof window !== 'undefined' ? window.location.search : ''
    const nextRaw = new URLSearchParams(search).get('next')
    const nextSuffix =
      nextRaw && nextRaw.startsWith('/') ? `?next=${encodeURIComponent(nextRaw)}` : ''

    void (async () => {
      // A Telegram launch waits for the loader's verdict; a browser gets no
      // wait at all (`0`), which is exactly what this route did before. It
      // renders nothing, and the page it forwards to runs the bounded wait
      // itself — so a bound here would only add a blank screen to every
      // logout, which lands on this route.
      const initData = await detectTelegramInitData(0)
      if (cancelled) return

      if (initData && initData.length > 0) {
        navigate(`/tma${nextSuffix}`, { replace: true })
      } else {
        navigate(nextSuffix ? `/${nextSuffix}` : '/', { replace: true })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [navigate])

  return null
}
