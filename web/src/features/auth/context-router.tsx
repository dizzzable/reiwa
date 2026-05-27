import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

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
 */
export default function ContextRouter() {
  const navigate = useNavigate()

  useEffect(() => {
    const initData =
      typeof window !== 'undefined' &&
      typeof window.Telegram !== 'undefined' &&
      typeof window.Telegram.WebApp !== 'undefined'
        ? window.Telegram.WebApp.initData
        : ''

    if (initData && initData.length > 0) {
      navigate('/tma', { replace: true })
    } else {
      navigate('/', { replace: true })
    }
  }, [navigate])

  return null
}
