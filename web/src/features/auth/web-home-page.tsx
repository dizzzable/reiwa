import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'

import { NetworkBg } from '@/components/ui/network-bg'
import { BrandLogo } from '@/components/ui/brand-logo'
import { useBranding } from '@/lib/branding-provider'
import { botSignin, getLanding, getSession } from '@/lib/api-client'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { LANDING_QUERY_KEY } from '@/features/landing/landing-page'
import { parseLandingPayload } from '@/features/landing/landing-schema'

/**
 * WebHomePage — entry point for browser users (`/`).
 *
 * Resolution order:
 *   1. **Magic-link from bot**: when the URL carries `?signin=<token>`,
 *      exchange it for a real WebSession via the BFF, strip the param
 *      from the address bar (so a refresh doesn't replay it) and push
 *      to `/dashboard`. Token is single-use; the strip prevents leaking
 *      it in the browser history when the user shares the page.
 *   2. **Existing cookie**: probe `GET /api/v1/session` and route to
 *      `/dashboard` on success.
 *   3. **No session**: route to `/sign-in`.
 *
 * No Telegram WebApp probing happens here — that path lives at `/tma`.
 * Browser users that arrive on the bare domain don't need to wait for
 * the Telegram SDK promise to (never) resolve.
 *
 * The splash mirrors the TMA bootstrap so brand chrome stays consistent
 * across both contexts. We tag the splash status copy with whichever
 * flow is active so a user staring at a long network round-trip knows
 * we're authenticating, not crashed.
 */
/**
 * Wait (bounded) for the Telegram WebApp SDK to populate `window.Telegram`.
 * Resolves as soon as the SDK object exists — `initData` present means we're
 * inside a Mini App, empty means a plain browser — so the decision is made
 * immediately in both real cases. Only when the (async) SDK script hasn't
 * loaded yet do we poll, falling back to `null` after `maxMs` so a browser
 * that can't reach telegram.org (RU IP, no VPN) is never stuck waiting.
 */
async function detectTelegramInitData(maxMs: number): Promise<string | null> {
  const start = Date.now()
  for (;;) {
    const webApp = window.Telegram?.WebApp
    if (webApp) {
      const data = webApp.initData
      return typeof data === 'string' && data.length > 0 ? data : null
    }
    if (Date.now() - start >= maxMs) return null
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

export default function WebHomePage() {
  const navigate    = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { branding } = useBranding()
  const calledRef   = useRef(false)
  const [statusKey, setStatusKey] = useState<'connecting' | 'signin'>('connecting')

  useEffect(() => {
    if (calledRef.current) return
    calledRef.current = true

    void (async () => {
      // Step 0 — Telegram Mini App hand-off. When the SPA is opened from
      // inside Telegram (inline web_app button, BotFather menu button, or any
      // deep-link to the bare domain), `initData` is present. Such users must
      // NOT see the login form — route them to /tma which authenticates via
      // Telegram. This makes the Mini App work regardless of which URL the
      // button points at, so operators never need to configure `/tma`.
      //
      // The Telegram SDK script is loaded `async` (so a RU-IP browser without
      // a VPN — which can't reach telegram.org — never blocks the first paint
      // on it). We therefore give the SDK a short, bounded window to populate
      // `window.Telegram`: the decision is final the moment the SDK object
      // exists (initData present → TMA, empty → plain browser); if it never
      // loads we fall through to the web flow after ~1.5s instead of hanging.
      const tgInitData = await detectTelegramInitData(1500)
      if (typeof tgInitData === 'string' && tgInitData.length > 0) {
        navigate('/tma', { replace: true })
        return
      }

      // Step 1 — magic-link consume (when present).
      const params = new URLSearchParams(window.location.search)
      const signinToken = params.get('signin')
      if (signinToken !== null && signinToken.length === 64 && /^[a-f0-9]+$/i.test(signinToken)) {
        setStatusKey('signin')
        try {
          const result = await botSignin(signinToken)
          // Strip the `?signin=` param either way: success means cookie
          // is set, failure means the token was bad and replays will
          // keep failing — leaving it in the URL just adds noise.
          params.delete('signin')
          const cleanedSearch = params.toString()
          const cleanedUrl =
            window.location.pathname + (cleanedSearch.length > 0 ? `?${cleanedSearch}` : '')
          window.history.replaceState({}, '', cleanedUrl)
          if (result.success) {
            // Pre-warm the session cache so /dashboard doesn't show a
            // skeleton on first paint.
            queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
            navigate(result.redirectUrl ?? '/dashboard', { replace: true })
            return
          }
        } catch {
          // Bad / expired token. Strip the param and fall through to
          // the standard cookie probe. /sign-in will surface the
          // generic `expired link` hint.
          params.delete('signin')
          const cleanedSearch = params.toString()
          const cleanedUrl =
            window.location.pathname + (cleanedSearch.length > 0 ? `?${cleanedSearch}` : '')
          window.history.replaceState({}, '', cleanedUrl)
        }
      }

      // Step 2 — existing-cookie probe.
      try {
        const session = await getSession()
        if (session) {
          queryClient.setQueryData(SESSION_QUERY_KEY, session)
          navigate('/dashboard', { replace: true })
          return
        }
      } catch {
        // No session — fall through to the landing/sign-in decision below.
      }

      // Step 3 — unauthenticated browser visitor: show the operator-authored
      // landing when it's enabled + published (has visible sections), else
      // the current behavior (straight to /sign-in). Reuses the same cached
      // `/api/v1/landing` fetch the landing page itself uses, so enabling
      // this never adds a second round-trip once warm.
      try {
        const landing = await queryClient.fetchQuery({
          queryKey: LANDING_QUERY_KEY,
          queryFn: getLanding,
          staleTime: 60_000,
        })
        const parsed = parseLandingPayload(landing)
        if (parsed.enabled === true && parsed.sections.length > 0) {
          navigate('/welcome', { replace: true })
          return
        }
      } catch {
        // Landing unavailable — fail closed to /sign-in (current behavior).
      }
      navigate('/sign-in', { replace: true })
    })()
  }, [navigate, queryClient])

  return (
    <div className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-(--brand-bg-primary)">
      <NetworkBg intensity="medium" />

      <div className="relative z-10 flex flex-col items-center gap-8 px-8 text-center">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', damping: 20, stiffness: 200 }}
        >
          <div
            className="flex h-24 w-24 items-center justify-center rounded-[28px] bg-white/5 ring-1 ring-white/10 backdrop-blur-xl"
            style={{ boxShadow: '0 0 60px var(--color-brand-glow)' }}
          >
            <BrandLogo className="h-14 w-14" />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h1 className="text-3xl font-bold tracking-[0.15em] text-white uppercase">
            {branding.brandName}
          </h1>
          <p className="mt-1 text-sm tracking-widest text-zinc-500 uppercase">
            {branding.tagline?.trim() || t('bootstrap.tagline')}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="flex items-center gap-3 text-sm text-zinc-500"
        >
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"
            style={{ borderColor: 'var(--brand-primary)', borderTopColor: 'transparent' }}
          />
          {statusKey === 'signin' ? t('bootstrap.connectingViaTelegram') : t('bootstrap.connecting')}
        </motion.div>
      </div>
    </div>
  )
}
