import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { NetworkBg } from '@/components/ui/network-bg'
import { EntryBrandTile } from '@/components/ui/entry-brand-tile'
import { useBranding } from '@/lib/branding-provider'
import { bootstrapTelegram } from '@/lib/api-client'
import { SESSION_QUERY_KEY, fetchSessionOrNull } from '@/hooks/use-session'
import { useTelegramWebApp } from '@/hooks/use-telegram-webapp'
import { readNextDestination } from '@/lib/next-destination'
import {
  forgetTelegramLaunchPayload,
  readTelegramLaunchInitData,
} from '@/lib/telegram-launch-params'

type BootstrapPhase = 'detecting' | 'authenticating' | 'ready' | 'error' | 'rate_limited'

export default function BootstrapPage() {
  const navigate    = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  // The root app owns the one-time Telegram host activation. This page only
  // consumes auth data, avoiding duplicate bridge calls on `/tma`.
  const { initData: sdkInitData, isReady, telegram } = useTelegramWebApp({ activate: false })
  const { branding } = useBranding()

  // The launch payload, straight from the URL — `initData` IS `tgWebAppData`,
  // and Telegram put it in the address bar before any script ran. The SDK's
  // copy is the fallback for launch shapes the URL does not carry. Signing in
  // must not wait on telegram.org: the user is here to BUY a VPN, so they do
  // not have one, and that is the host their network blocks.
  const launchInitData = useMemo(() => readTelegramLaunchInitData(), [])
  const initData = launchInitData ?? sdkInitData
  const [phase, setPhase]     = useState<BootstrapPhase>('detecting')
  const [errorMsg, setErrorMsg] = useState('')
  const [retryAfter, setRetryAfter] = useState(0)
  const calledRef = useRef(false)

  // Intended deep-link destination forwarded by the context router / Mini App
  // deep-link (`?next=/renew`). Only same-origin absolute paths are honoured, so
  // a crafted `next` can't redirect the user off-app — that rule now lives in
  // `lib/next-destination.ts`, shared with the credential gates that stand
  // downstream of this page.
  const nextDestination = readNextDestination()

  useEffect(() => {
    if (calledRef.current) return
    // Start the moment there is something to authenticate with. Waiting for
    // `isReady` once the payload is already in hand would put the telegram.org
    // fetch back in front of the sign-in — which is the failure this page sits
    // downstream of. Only a launch with no payload of its own still waits for
    // the SDK to settle, because for that one the bridge is the last hope.
    if (initData === null && !isReady) return
    calledRef.current = true

    async function run() {
      try {
        // 1. Try existing session first — through the shared React-Query key,
        // so this probe joins the `useSession()` request already in flight
        // from the app root (`use-ad-attribution`) instead of issuing a second
        // concurrent `/api/v1/session`. A failed probe still means "need to
        // bootstrap", exactly as before; `fetchQuery` caches a success, which
        // is what the old `setQueryData` did by hand.
        //
        // `staleTime: 0` deliberately, NOT the shared `SESSION_STALE_TIME_MS`.
        // The concurrent dedup this step exists for survives it — React Query
        // joins a fetch already in flight under this key. A non-zero staleTime
        // would additionally reuse an already-RESOLVED result, and because
        // `fetchSessionOrNull` turns a network failure into a successful
        // `null`, a root probe that failed would be replayed here as a
        // confident answer for a full minute. Harmless on this page (a `null`
        // only means "bootstrap", which is the sign-in), but the probe should
        // not be the place a swallowed error becomes sticky.
        setPhase('authenticating')
        try {
          const session = await queryClient.fetchQuery({
            queryKey: SESSION_QUERY_KEY,
            queryFn: fetchSessionOrNull,
            staleTime: 0,
            retry: false,
          })
          if (session) {
            setPhase('ready')
            navigate(nextDestination ?? '/dashboard', { replace: true })
            return
          }
        } catch {
          // NOT the "no existing session" path — `fetchSessionOrNull` swallows
          // the 401 and RETURNS null, so a missing session is the falsy
          // `session` above and falls through to the bootstrap below on its
          // own. Nothing in the query function throws; this only fires if
          // `fetchQuery` itself rejects (a CancelledError from a
          // `cancelQueries` elsewhere). Kept as defence in depth so such a
          // rejection still reaches the initData bootstrap instead of the
          // outer catch's error screen.
        }

        // 2. Bootstrap with Telegram initData
        if (!initData) {
          // No TMA context — show sign-in alternative or error
          setErrorMsg(t('bootstrap.openInTelegram'))
          setPhase('error')
          return
        }

        const result = await bootstrapTelegram(initData)
        // The WebSession cookie is set server-side. Drop any cached session
        // so guards refetch `/session` and see the fresh authenticated state.
        await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })

        telegram?.HapticFeedback?.notificationOccurred('success')
        setPhase('ready')
        navigate(nextDestination ?? result.redirectUrl ?? '/dashboard', { replace: true })
      } catch (err: unknown) {
        const waitSeconds = getRetryAfter(err)
        if (waitSeconds !== null) {
          setRetryAfter(waitSeconds)
          setPhase('rate_limited')
          return
        }
        // The server REFUSED this payload (401: the HMAC did not verify, or
        // `auth_date` is past its 24h window). Retry, below, is
        // `window.location.reload()` — a new document, which reads the payload
        // back out of the session mirror and sends the identical bytes to the
        // identical refusal. Dropping it here is what turns an unbreakable loop
        // into one failure the user can act on.
        //
        // Only 401. A 400 is "the request carried nothing / the operator has no
        // BOT_TOKEN", a 429 never reaches here, and 5xx and transport failures
        // are transient — discarding a good payload for any of those would cost
        // the launch for a reason that was going to clear on its own.
        if (isAxiosErrorLike(err) && err.response?.status === 401) {
          forgetTelegramLaunchPayload()
        }
        setErrorMsg(resolveBootstrapError(err, t))
        setPhase('error')
        telegram?.HapticFeedback?.notificationOccurred('error')
      }
    }

    void run()
  }, [isReady, initData, navigate, queryClient, telegram, t, nextDestination])

  useEffect(() => {
    if (phase !== 'rate_limited' || retryAfter <= 0) return
    const timer = window.setInterval(() => {
      setRetryAfter((current) => {
        if (current <= 1) {
          window.clearInterval(timer)
          calledRef.current = false
          setPhase('detecting')
          return 0
        }
        return current - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase, retryAfter])

  return (
    // Outside `StealthLayout`, so this page has to be its own scroller —
    // same reason as `/legal` and `/support/guest`, see the note there. It
    // was bounded (`h-dvh`) but sealed (`overflow-hidden`): the
    // `phase === 'error'` branch carries a `whitespace-pre-line` message
    // that the BFF may extend with a multi-line `[dev]` block (up to 500
    // characters of upstream body, `bootstrapClientError` in
    // `src/api/routes/auth.ts`) plus the retry button under it. Measured
    // in Chrome with such a message: the column is 526px, so at 375x360 it
    // started at -83px and the retry button ended 66px below the fold with
    // a user scroll range of 0.
    //
    // `scroll-area` ALONE on the old root would not have fixed it, and
    // that is why the shape below is the entry screens’ and not a one-word
    // change. The root centred its own child (`flex ... justify-center`),
    // and a flex container that centres overflows at BOTH ends — but only
    // the end-edge overflow joins the scrollable region. Same viewport,
    // same message, `overflow-hidden` swapped for `scroll-area`: scroll
    // range 83px, retry reachable, and the brand tile still frozen at
    // -83px with no way up. Moving the centring INTO a `min-h-full` column
    // puts the whole column back inside the scrollable box: scroll range
    // 230px, both ends reachable, and while the content fits the column is
    // exactly 100dvh so the centring is unchanged.
    //
    // `overflow-x-hidden` keeps the promoted cross axis sealed:
    // `overflow-y: auto` turns a `visible` `overflow-x` into `auto`, and a
    // `[dev]` dump can carry an unbreakable JSON token wider than the
    // screen (measured: a 461px word inside a 311px column). Clipping it
    // is what the root already did; a horizontal scrollbar would be new.
    <div className="scroll-area relative h-dvh overflow-x-hidden bg-(--brand-bg-primary)">
      <NetworkBg intensity="medium" />

      <div className="relative z-10 flex min-h-full flex-col items-center justify-center gap-8 px-8 py-8 text-center">
        {/* Logo/brand */}
        <EntryBrandTile size="lg" />

        {/* Brand name */}
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

        {/* Status */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="flex flex-col items-center gap-3"
        >
          {phase === 'rate_limited' ? (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-6 py-4 text-sm text-amber-200">
              <p className="font-medium">{t('bootstrap.rateLimitedTitle')}</p>
              <p className="mt-1 text-xs text-amber-100/80">{t('bootstrap.rateLimited', { seconds: retryAfter })}</p>
            </div>
          ) : phase === 'error' ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-6 py-4 text-sm text-red-400">
              <p className="font-medium">{t('bootstrap.loginError')}</p>
              {/* `wrap-anywhere` (`overflow-wrap: anywhere`), NOT `break-words`.
                  The BFF may extend this message with a `[dev]` block holding up
                  to 500 characters of raw upstream body (`resolveBootstrapError`
                  below, fed by `debug: upstream 403: ${body.slice(0, 500)}` in
                  `src/api/routes/auth.ts`), and those bodies are JSON: one
                  unbreakable word a few hundred characters long is the ordinary
                  case here. The card above is a shrink-to-fit flex item, so that
                  word IS its width — measured in Chrome at 375px, a 231-char
                  body made the card 742px inside a 309px column, and the root's
                  `overflow-x-hidden` clipped the rest away with no scrollbar.

                  `break-words` would NOT fix that. Its break opportunities are
                  excluded from min-content intrinsic size (CSS Text 3 §5.5), and
                  min-content is exactly what sizes this box: measured, the card
                  stays 742px with it. `anywhere` is the value whose
                  opportunities count — 309px, fits. `break-all` also fits but
                  chops ordinary words mid-character, mangling the readable first
                  line.

                  This is NOT an argument against the plain `break-words` used
                  elsewhere in the app. The support bubbles and the settings rows
                  carry a width CAP (`max-w-[80%]`, `max-w-[220px]`), and once a
                  cap bounds the box its min-content contribution stops deciding
                  anything — `break-word` then wraps the token inside the cap just
                  fine. This card has no cap, which is the whole difference.
                  Guarded by `web/test/tma-error-message-wrapping.test.tsx`. */}
              <p className="mt-1 text-xs text-red-500/80 whitespace-pre-line wrap-anywhere">{errorMsg}</p>
              <button
                onClick={() => {
                  calledRef.current = false
                  setPhase('detecting')
                  window.location.reload()
                }}
                className="mt-3 rounded-full bg-red-500/20 px-4 py-1.5 text-xs text-red-400 hover:bg-red-500/30 transition-colors"
              >
                {t('bootstrap.retry')}
              </button>
            </div>
          ) : phase === 'ready' ? (
            <p className="text-sm text-emerald-400">✓ {t('bootstrap.loginSuccess')}</p>
          ) : (
            <div className="flex items-center gap-3 text-sm text-[color:var(--brand-muted-foreground)]">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
              {phase === 'detecting' ? t('bootstrap.initializing') : t('bootstrap.signingIn')}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

// ── Error mapping ────────────────────────────────────────────────────────────
// Public users only ever see product-level copy (access mode gates) or a
// generic "could not sign in". Operator/env diagnostics (Origin/CSRF,
// BOT_TOKEN, REIWA_DOMAIN, token-null reasons) are never inferred client-side:
// the BFF attaches them as `debug` only when the caller's Telegram id equals
// `BOT_DEV_ID` (server-side check).

interface BootstrapErrorBody {
  code?: string
  message?: string
  retryAfter?: number
  /** Present only for BOT_DEV_ID — never rely on this for regular UX. */
  debug?: string
}

function getRetryAfter(err: unknown): number | null {
  if (!isAxiosErrorLike(err) || err.response?.status !== 429) return null
  const data = err.response.data
  const retryAfter =
    data && typeof data === 'object' && 'retryAfter' in data
      ? (data as BootstrapErrorBody).retryAfter
      : undefined
  return typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0
    ? retryAfter
    : 60
}

interface AxiosErrorLike {
  response?: {
    status: number
    data?: BootstrapErrorBody | string
  }
  message?: string
}

function isAxiosErrorLike(err: unknown): err is AxiosErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as AxiosErrorLike).response?.status === 'number'
  )
}

function resolveBootstrapError(
  err: unknown,
  t: (key: string) => string,
): string {
  if (isAxiosErrorLike(err)) {
    const data = err.response?.data
    const body: BootstrapErrorBody =
      typeof data === 'string'
        ? { message: data }
        : data && typeof data === 'object'
          ? data
          : {}

    let userMsg: string
    switch (body.code) {
      case 'REGISTRATION_DISABLED':
        userMsg = t('bootstrap.registrationDisabled')
        break
      case 'INVITE_REQUIRED':
        userMsg = t('bootstrap.inviteRequired')
        break
      case 'SERVICE_RESTRICTED':
        userMsg = t('bootstrap.serviceRestricted')
        break
      default:
        // Do not forward raw server strings (Origin/CSRF, Access denied, …)
        // — they leak deployment internals to every Mini App user.
        userMsg = t('bootstrap.accessDenied')
        break
    }

    // Server only sets `debug` after verifying BOT_DEV_ID against initData.
    const debug = typeof body.debug === 'string' ? body.debug.trim() : ''
    if (debug) {
      return `${userMsg}\n\n[dev] ${debug}`
    }
    return userMsg
  }

  return t('bootstrap.loginErrorFallback')
}
