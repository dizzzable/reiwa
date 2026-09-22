import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { bootstrapTelegram, getBrowserKey } from '@/lib/api-client'
import { readTelegramLaunchInitData, readTelegramLaunchPlatform } from '@/lib/telegram-launch-params'
import { openExternalUrl } from '@/lib/utils'

import { BROWSER_KEY_REFRESH_MS, browserOpenUrl, launchUserLabel, opensWithoutTap } from './browser-handoff'

/**
 * `/open-in-browser` — what «Кабинет» in the bot opens: the Mini App, whose one
 * job is to open the cabinet in the phone's own browser, signed in.
 *
 * Inside the protected shell on purpose: the session and «Канал обязателен»
 * are settled before this page draws, exactly as for any other Mini App page,
 * so a new subscriber meets the channel screen here and gets no key before it.
 *
 * The key is fetched as the page OPENS, not when the button is tapped. The
 * mobile clients carry out `openLink` only inside a physical tap, and a tap
 * that first waits for the network has lost it by the time the key arrives —
 * the defect that once swallowed every checkout redirect. It is refreshed a
 * minute before the panel lets it lapse, and again after each tap, because the
 * browser that opened has just spent the one it carried.
 *
 * ── Whose key ───────────────────────────────────────────────────────────────
 *
 * The shell signs in from its cookie when there is one, and Telegram keeps
 * several accounts in one app with ONE cookie store — so the session may be a
 * different Telegram account from the one that tapped. The key request carries
 * the tap's launch data, and the server refuses a mismatch
 * (`LAUNCH_ACCOUNT_MISMATCH`); this page then offers to sign in as the account
 * that tapped, by a tap of its own — never silently, since launch data can
 * also arrive in a crafted link.
 */

const BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 py-3 text-sm font-semibold'

type KeyState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly key: string }
  | { readonly kind: 'failed' }
  /** The session is another Telegram account's than the one that tapped. */
  | { readonly kind: 'mismatch' }
  /** No launch data this server will take — absent, forged, or past its 24 h. */
  | { readonly kind: 'relaunch' }

/** Why the server refused, when the refusal is one this page answers differently from a failure. */
function refusalOf(err: unknown): 'mismatch' | 'relaunch' | null {
  const response = (err as { response?: { status?: unknown; data?: { message?: unknown } } } | null)?.response
  const message = response?.data?.message
  if (response?.status === 409 && message === 'LAUNCH_ACCOUNT_MISMATCH') return 'mismatch'
  if (response?.status === 401 && (message === 'LAUNCH_DATA_REQUIRED' || message === 'LAUNCH_DATA_INVALID')) {
    return 'relaunch'
  }
  return null
}

/** The tap's launch data: the URL first, the bridge only for a launch shape the URL never carried. */
function launchInitData(): string | null {
  const fromUrl = readTelegramLaunchInitData()
  if (fromUrl !== null) return fromUrl
  const fromBridge = window.Telegram?.WebApp?.initData
  return typeof fromBridge === 'string' && fromBridge.length > 0 ? fromBridge : null
}

export default function OpenInBrowserPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const initData = useMemo(() => launchInitData(), [])
  const launchName = useMemo(() => launchUserLabel(initData), [initData])
  const [state, setState] = useState<KeyState>({ kind: 'loading' })
  const [opened, setOpened] = useState(false)
  const alive = useRef(true)
  const autoOpened = useRef(false)

  const fetchKey = useCallback(async (): Promise<void> => {
    if (initData === null) {
      setState({ kind: 'relaunch' })
      return
    }
    try {
      const { key } = await getBrowserKey(initData)
      if (alive.current) setState({ kind: 'ready', key })
    } catch (err: unknown) {
      if (!alive.current) return
      const refusal = refusalOf(err)
      if (refusal !== null) {
        setState({ kind: refusal })
        return
      }
      // A refresh that fails keeps the key in hand: it may still have a minute,
      // and a button that vanishes under a finger is worse than a spent key.
      setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'failed' }))
    }
  }, [initData])

  useEffect(() => {
    alive.current = true
    void fetchKey()
    const timer = setInterval(() => void fetchKey(), BROWSER_KEY_REFRESH_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [fetchKey])

  const open = useCallback(
    (key: string): void => {
      // Synchronously, inside the tap — see the header.
      openExternalUrl(browserOpenUrl(window.location.origin, key))
      setOpened(true)
      void fetchKey()
    },
    [fetchKey],
  )

  // Sign in as the account that tapped: the server verifies the launch data's
  // HMAC and mints that account's session over the shared cookie.
  const switchAccount = useCallback(async (): Promise<void> => {
    if (initData === null) return
    setState({ kind: 'loading' })
    try {
      await bootstrapTelegram(initData)
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      await fetchKey()
    } catch {
      if (alive.current) setState({ kind: 'failed' })
    }
  }, [initData, queryClient, fetchKey])

  // Telegram Desktop needs no tap: there «Кабинет» is one press in the bot.
  useEffect(() => {
    if (state.kind !== 'ready' || autoOpened.current) return
    if (!opensWithoutTap(readTelegramLaunchPlatform())) return
    autoOpened.current = true
    open(state.key)
  }, [state, open])

  return (
    // A page inside the cabinet's own shell (its navigation stays), so it takes
    // the shell's width and background rather than a full-screen one of its own.
    <div
      data-testid="open-in-browser"
      data-state={state.kind}
      className="px-4 text-[color:var(--brand-foreground)]"
    >
      <div className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col justify-center gap-4 py-10">
        <h1 className="text-xl font-semibold">{t('openInBrowser.title')}</h1>

        {state.kind === 'mismatch' ? (
          <>
            <p role="alert" className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {t('openInBrowser.mismatchBody')}
            </p>
            <button
              type="button"
              data-open-in-browser-switch=""
              onClick={() => void switchAccount()}
              className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
            >
              {launchName === null
                ? t('openInBrowser.switchAsThis')
                : t('openInBrowser.switchAs', { name: launchName })}
            </button>
          </>
        ) : state.kind === 'relaunch' ? (
          <p role="alert" className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {t('openInBrowser.relaunchBody')}
          </p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {t(opened ? 'openInBrowser.openedBody' : 'openInBrowser.body')}
            </p>

            {state.kind === 'failed' ? (
              <>
                <p role="alert" className="text-sm text-[color:var(--brand-muted-foreground)]">
                  {t('openInBrowser.failed')}
                </p>
                <button
                  type="button"
                  data-open-in-browser-retry=""
                  onClick={() => {
                    setState({ kind: 'loading' })
                    void fetchKey()
                  }}
                  className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
                >
                  {t('openInBrowser.retry')}
                </button>
              </>
            ) : (
              <button
                type="button"
                data-open-in-browser=""
                disabled={state.kind !== 'ready'}
                onClick={() => {
                  if (state.kind === 'ready') open(state.key)
                }}
                className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)] disabled:opacity-60`}
              >
                <ExternalLink aria-hidden="true" className="size-4" />
                {t(opened ? 'openInBrowser.openAgain' : 'openInBrowser.open')}
              </button>
            )}
          </>
        )}

        <button
          type="button"
          data-open-in-browser-stay=""
          onClick={() => navigate('/dashboard')}
          className={`${BUTTON} text-[color:var(--brand-muted-foreground)]`}
        >
          {t('openInBrowser.stay')}
        </button>
      </div>
    </div>
  )
}
