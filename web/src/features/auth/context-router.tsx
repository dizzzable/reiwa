import { useEffect } from 'react'
import { useNavigate } from 'react-router'

import { nextDestinationQuery } from '@/lib/next-destination'

import { detectTelegramInitData } from './telegram-launch'

/**
 * ContextRouter — fallback hub at `/bootstrap`.
 *
 * Historically `/bootstrap` was the single TMA entry point that browser
 * users ended up on through the catch-all redirect. It now plays a
 * smaller role: detect the runtime context once, and forward to the
 * dedicated entry route.
 *
 *  - a non-empty launch `initData` → redirect to `/tma` (which performs
 *    the actual Telegram auth handshake). That is `detectTelegramInitData`
 *    below, which reads `tgWebAppData` off the URL / capture / session
 *    mirror; it has NOT read `Telegram.WebApp.initData` since `c087865`,
 *    and describing it as if it did is how a bridge-only read in
 *    `lib/client-source.ts` survived three sweeps citing this file as its
 *    precedent.
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
 * send a Mini App user to the login form. Hence the shared decision in
 * `telegram-launch.ts`, which now reads the launch off the URL rather than
 * waiting for telegram.org to describe it — and mirrors it into the session
 * store on the way, so the hash this route drops is no longer the only copy.
 */
export default function ContextRouter() {
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false

    // Preserve an intended deep-link destination (`?next=`) across the
    // context hop so Mini App deep-links survive the bootstrap redirect. The
    // same-origin rule is the shared one, so this hop cannot forward a value
    // the pages downstream would refuse.
    const search = typeof window !== 'undefined' ? window.location.search : ''
    const nextSuffix = nextDestinationQuery(new URLSearchParams(search).get('next'))

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
