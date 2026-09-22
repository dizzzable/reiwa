import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { fetchSessionOrNull, useSession } from '@/hooks/use-session'
import { bootstrapTelegram } from '@/lib/api-client'
import { readTelegramLaunchInitData } from '@/lib/telegram-launch-params'

import { isAxiosErrorLike, resolveBootstrapError } from './bootstrap-error'
import { isOtherTelegramAccount, isTelegramWebview, readLaunchAccount, type LaunchAccount } from './launch-account'
import { reloadPage } from './leave-page'

/**
 * ONE APP, SEVERAL ACCOUNTS, ONE COOKIE STORE. Telegram lets a phone hold
 * several accounts and gives them one WebView cookie store, and the cabinet
 * signs in from the cookie whenever there is one. So account B opening the
 * Mini App where account A signed in earlier was shown A's cabinet — and could
 * pay into it — without a word.
 *
 * Now the account that opened the app is the account shown: when the session
 * is another Telegram account than the launch's, this signs in as the launch's
 * account before anything else draws (`launch-account.ts` has the why, and
 * where it does not).
 *
 * Above «Канал обязателен» on purpose — see `App.tsx`. The gate asks about the
 * SESSION's account, so below it B met A's channel screen, which no
 * subscription of B's lifts, or walked in on A's subscription.
 */

interface Launch {
  readonly account: LaunchAccount
  readonly initData: string
}

export function LaunchAccountGate({
  children,
  fallback,
}: {
  readonly children: ReactNode
  /** Shown while the session is read, where there is a launch to compare it with. */
  readonly fallback: ReactNode
}) {
  // Read once: the launch and where the document runs do not change while it lives.
  const [launch] = useState<Launch | null>(() => {
    if (!isTelegramWebview()) return null
    const initData = readTelegramLaunchInitData()
    const account = readLaunchAccount(initData)
    return initData !== null && account !== null ? { account, initData } : null
  })
  if (launch === null) return children
  return (
    <LaunchAccountCheck launch={launch} fallback={fallback}>
      {children}
    </LaunchAccountCheck>
  )
}

function LaunchAccountCheck({
  launch,
  fallback,
  children,
}: {
  readonly launch: Launch
  readonly fallback: ReactNode
  readonly children: ReactNode
}) {
  const { session, isLoading } = useSession()
  // Nothing below may start on the previous account's behalf while this is unknown.
  if (isLoading) return fallback
  if (session !== null && isOtherTelegramAccount(session.telegramId, launch.account)) {
    return <LaunchAccountSwitch launch={launch.account} initData={launch.initData} />
  }
  return children
}

const BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 py-3 text-sm font-semibold'

/**
 * `/auth/telegram/bootstrap` verifies the launch data's HMAC with the bot token
 * and mints that account's session over the shared cookie. The session is then
 * read back and must BE that account before the page reloads: a bootstrap that
 * answers but leaves the cookie as it was would otherwise reload into the same
 * switch forever. Checked first, a switch that did not take is an error
 * screen, and the previous account's cabinet is never drawn.
 *
 * A reload, not a cache reset: the query cache is not all the previous account
 * left behind — its live-updates stream would go on delivering its payments to
 * the new account's screen, and nothing in the stream notices a switch.
 */
export function LaunchAccountSwitch({
  launch,
  initData,
}: {
  readonly launch: LaunchAccount
  readonly initData: string
}) {
  const { t } = useTranslation()
  const started = useRef(false)
  /** What the failure screen says; `null` while switching. */
  const [failed, setFailed] = useState<string | null>(null)

  const signIn = useCallback(async (): Promise<void> => {
    started.current = true
    setFailed(null)
    try {
      await bootstrapTelegram(initData)
      const session = await fetchSessionOrNull()
      if (session === null || String(session.telegramId ?? '') !== launch.id) {
        setFailed(t('launchSwitch.failed'))
        return
      }
      reloadPage()
    } catch (err: unknown) {
      // A refusal (403, or 503 «сервис ограничен») says why, in the words the
      // Mini App's first launch uses: reopening the app only repeats it, so
      // «try again» alone would be a dead end. Anything else is a failure
      // worth retrying.
      const status = isAxiosErrorLike(err) ? err.response?.status : undefined
      setFailed(status === 403 || status === 503 ? resolveBootstrapError(err, t) : t('launchSwitch.failed'))
    }
  }, [initData, launch.id, t])

  useEffect(() => {
    // Once per mount: React runs effects twice in development.
    if (started.current) return
    void signIn()
  }, [signIn])

  return (
    <div
      data-testid="launch-account-switch"
      data-state={failed !== null ? 'failed' : 'switching'}
      className="relative flex min-h-dvh items-center justify-center bg-(--brand-bg-primary) px-6 text-[color:var(--brand-foreground)]"
    >
      {failed !== null ? (
        <div className="flex w-full max-w-sm flex-col gap-4 py-10">
          <p role="alert" className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {failed}
          </p>
          <button
            type="button"
            data-launch-switch-retry=""
            onClick={() => void signIn()}
            className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
          >
            {t('launchSwitch.retry')}
          </button>
        </div>
      ) : (
        <div role="status" className="flex flex-col items-center gap-4">
          <div
            aria-hidden="true"
            className="size-8 animate-spin rounded-full border-2 border-t-transparent"
            style={{ borderColor: 'var(--brand-primary)', borderTopColor: 'transparent' }}
          />
          <p className="text-sm text-[color:var(--brand-muted-foreground)]">
            {launch.label === null
              ? t('launchSwitch.signingIn')
              : t('launchSwitch.signingInAs', { name: launch.label })}
          </p>
        </div>
      )}
    </div>
  )
}
