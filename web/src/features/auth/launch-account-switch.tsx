import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { fetchSessionOrNull } from '@/hooks/use-session'
import { bootstrapTelegram } from '@/lib/api-client'

import type { LaunchAccount } from './launch-account'

/**
 * What the shell shows while it signs in as the Telegram account that opened
 * the Mini App, when the cookie session is another one (`launch-account.ts`).
 *
 * `/auth/telegram/bootstrap` verifies the launch data's HMAC with the bot token
 * and mints that account's session over the shared cookie. The session is then
 * read back and must BE that account before anything is reset: a bootstrap that
 * answers but leaves the cookie as it was would otherwise loop — the reset
 * remounts the shell, which finds the old session and switches again. Checked
 * first, a switch that did not take is an error screen, and the previous
 * account's cabinet is never drawn.
 *
 * Then EVERY query is reset, not only the session: the channel gate and
 * whatever else was read for the previous account must not answer for this one.
 */

const BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 py-3 text-sm font-semibold'

export function LaunchAccountSwitch({
  launch,
  initData,
}: {
  readonly launch: LaunchAccount
  readonly initData: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const started = useRef(false)
  const [failed, setFailed] = useState(false)

  const signIn = useCallback(async (): Promise<void> => {
    started.current = true
    setFailed(false)
    try {
      await bootstrapTelegram(initData)
      const session = await fetchSessionOrNull()
      if (session === null || String(session.telegramId ?? '') !== launch.id) {
        setFailed(true)
        return
      }
      await queryClient.resetQueries()
    } catch {
      setFailed(true)
    }
  }, [initData, launch.id, queryClient])

  useEffect(() => {
    // Once per mount: React runs effects twice in development.
    if (started.current) return
    void signIn()
  }, [signIn])

  return (
    <div
      data-testid="launch-account-switch"
      data-state={failed ? 'failed' : 'switching'}
      className="relative flex min-h-dvh items-center justify-center bg-(--brand-bg-primary) px-6 text-[color:var(--brand-foreground)]"
    >
      {failed ? (
        <div className="flex w-full max-w-sm flex-col gap-4 py-10">
          <p role="alert" className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {t('launchSwitch.failed')}
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
