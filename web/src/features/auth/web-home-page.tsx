import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'

import { NetworkBg } from '@/components/ui/network-bg'
import { EntryBrandTile } from '@/components/ui/entry-brand-tile'
import { useBranding } from '@/lib/branding-provider'
import { botSignin, getLanding } from '@/lib/api-client'
import { SESSION_QUERY_KEY, fetchSessionOrNull } from '@/hooks/use-session'
import { LANDING_QUERY_KEY } from '@/features/landing/landing-page'
import { parseLandingPayload } from '@/features/landing/landing-schema'
import { detectTelegramInitData } from './telegram-launch'

/**
 * WebHomePage — entry point for browser users (`/`).
 *
 * Resolution order:
 *   0. **Telegram Mini App**: bot buttons and deep-links point at the bare
 *      domain as often as at `/tma`, so this route has to recognise a Mini
 *      App launch and hand it to `/tma` — a Telegram-first user has no
 *      password and must never reach the login form. See `telegram-launch.ts`
 *      for how long the SDK is waited for, which is the whole subtlety.
 *   1. **Magic-link from bot**: when the URL carries `?signin=<token>`,
 *      exchange it for a real WebSession via the BFF, strip the param
 *      from the address bar (so a refresh doesn't replay it) and push
 *      to `/dashboard`. Token is single-use; the strip prevents leaking
 *      it in the browser history when the user shares the page.
 *   2. **Existing cookie**: probe `GET /api/v1/session` and route to
 *      `/dashboard` on success.
 *   3. **No session**: route to the landing when the operator published one,
 *      else `/sign-in`.
 *
 * The splash mirrors the TMA bootstrap so brand chrome stays consistent
 * across both contexts. We tag the splash status copy with whichever
 * flow is active so a user staring at a long network round-trip knows
 * we're authenticating, not crashed.
 */
/**
 * Ceiling on the SDK wait — for a launch with NO Telegram parameters only, and
 * only for the ordering race where a bridge turns up anyway. A launch that
 * carries `tgWebAppData` never reaches a clock at all; `telegram-launch.ts`
 * explains why the two cases cannot share one.
 */
const BROWSER_SDK_WAIT_MS = 1500

/**
 * Params worth carrying across an entry redirect: marketing attribution and the
 * post-auth destination. An allowlist, not a copy of the whole query — the entry
 * URL can also hold the single-use `?signin=` magic-link token, and forwarding
 * that into /tma or /sign-in (neither of which consumes it) would leak it into
 * browser history and proxy logs. A denylist would leak the next one-shot param
 * somebody adds.
 */
const CARRIED_PARAMS = ['ref', 'next'] as const

/**
 * Appends the carried query params to a client-side navigation target.
 *
 * Every hand-off out of this page used to pass a bare path, so react-router
 * replaced the URL without its query — dropping the `utm_*` tags the register
 * form reads off `window.location.search`, and (before the server started
 * capturing it) the `?campaign=ad_<code>` advertising marker with them. Targets
 * that carry their own query are left untouched.
 */
function keepQuery(target: string): string {
  if (target.includes('?')) return target
  const carried = new URLSearchParams()
  const current = new URLSearchParams(window.location.search)
  for (const [key, value] of current) {
    if (key.startsWith('utm_') || (CARRIED_PARAMS as readonly string[]).includes(key)) {
      carried.set(key, value)
    }
  }
  const query = carried.toString()
  return query.length > 0 ? `${target}?${query}` : target
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
      // `initData` IS `tgWebAppData`, and Telegram puts it in the URL fragment
      // of the launch document, so for a real Mini App this resolves with no
      // network at all. It used to wait for telegram.org to hand the same value
      // back through `window.Telegram` — and the users who arrive here are
      // shopping for a VPN, so telegram.org is the one host they cannot reach.
      // Every failed fetch became "plain browser", i.e. a password form for a
      // user who has never had a password. Nothing downstream undoes that.
      //
      // Only a launch whose URL carries no payload still consults the SDK, and
      // only then does `BROWSER_SDK_WAIT_MS` mean anything.
      const tgInitData = await detectTelegramInitData(BROWSER_SDK_WAIT_MS)
      if (typeof tgInitData === 'string' && tgInitData.length > 0) {
        navigate(keepQuery('/tma'), { replace: true })
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
            navigate(keepQuery(result.redirectUrl ?? '/dashboard'), { replace: true })
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

      // Step 2 — existing-cookie probe, through the shared React-Query key so
      // it collapses into the `useSession()` request the app root has already
      // fired on this same mount (`use-ad-attribution`) instead of issuing a
      // second concurrent `/api/v1/session`. `fetchQuery` also caches the
      // result, which is what the old `setQueryData` did by hand.
      //
      // `staleTime: 0` deliberately, NOT the shared `SESSION_STALE_TIME_MS`.
      // The dedup this step exists for is the CONCURRENT one, and React Query
      // gives that regardless of staleness: a fetch already in flight under this
      // key is joined, not duplicated. What a non-zero staleTime would add is
      // reuse of a result that already RESOLVED — and `fetchSessionOrNull`
      // converts a network failure into a successful `null`, so a root probe
      // that failed would be served to this decision as a confident "no
      // session" for a full minute, sending a signed-in visitor to /sign-in.
      // The cost of 0 is one extra round-trip when the root probe happened to
      // land first; the cost of 60_000 is routing on a swallowed error.
      try {
        const session = await queryClient.fetchQuery({
          queryKey: SESSION_QUERY_KEY,
          queryFn: fetchSessionOrNull,
          staleTime: 0,
          retry: false,
        })
        if (session) {
          navigate(keepQuery('/dashboard'), { replace: true })
          return
        }
      } catch {
        // NOT the "no session" path — `fetchSessionOrNull` swallows the 401 and
        // RETURNS null, so the falsy `session` above is what an unauthenticated
        // visitor produces. Nothing in the query function throws, so this only
        // fires if `fetchQuery` itself rejects (a CancelledError from a
        // `cancelQueries` elsewhere). Kept as defence in depth: the outer
        // effect is a bare `void (async () => …)()`, so an escaping rejection
        // would be an unhandled one and the visitor would sit on the splash
        // forever instead of falling through to the decision below.
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
          navigate(keepQuery('/welcome'), { replace: true })
          return
        }
      } catch {
        // Landing unavailable — fail closed to /sign-in (current behavior).
      }
      navigate(keepQuery('/sign-in'), { replace: true })
    })()
  }, [navigate, queryClient])

  return (
    <div className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-(--brand-bg-primary)">
      <NetworkBg intensity="medium" />

      <div className="relative z-10 flex flex-col items-center gap-8 px-8 text-center">
        <EntryBrandTile size="lg" />

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h1 className="text-3xl font-bold tracking-[0.15em] text-[color:var(--brand-foreground)] uppercase">
            {branding.brandName}
          </h1>
          <p className="mt-1 text-sm tracking-widest text-[color:var(--brand-muted-foreground)] uppercase">
            {branding.tagline?.trim() || t('bootstrap.tagline')}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="flex items-center gap-3 text-sm text-[color:var(--brand-muted-foreground)]"
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
