import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { bootstrapTelegram } from '@/lib/api-client'

import type { LaunchAccount } from './launch-account'

/**
 * «Кабинет открыт под другим аккаунтом» — the question the shell asks when the
 * cookie session is another Telegram account than the one that opened the Mini
 * App (`launch-account.ts`). Asked, never decided: launch data can arrive in a
 * crafted link too, and the visitor is the one who knows which account is theirs.
 *
 * «Войти как …» signs in as the launch's account through
 * `/auth/telegram/bootstrap`, which verifies the payload's HMAC with the bot
 * token; the refreshed session then takes the shell past this screen. «Остаться
 * как …» keeps the session for the rest of this launch.
 */

const BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 py-3 text-sm font-semibold disabled:opacity-60'

export function LaunchAccountChoice({
  sessionLabel,
  launch,
  initData,
  onStay,
}: {
  /** The session's name or @username; `null` when it has neither. */
  readonly sessionLabel: string | null
  readonly launch: LaunchAccount
  readonly initData: string
  readonly onStay: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<'idle' | 'switching' | 'failed'>('idle')

  async function switchAccount(): Promise<void> {
    setPhase('switching')
    try {
      await bootstrapTelegram(initData)
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    } catch {
      setPhase('failed')
    }
  }

  const launchLabel = launch.label ?? t('launchChoice.thisAccount')
  const ownLabel = sessionLabel ?? t('launchChoice.currentAccount')
  return (
    <div
      data-testid="launch-account-choice"
      className="relative flex min-h-dvh items-center justify-center bg-(--brand-bg-primary) px-6 text-[color:var(--brand-foreground)]"
    >
      <div className="flex w-full max-w-sm flex-col gap-4 py-10">
        <h1 className="text-xl font-semibold">{t('launchChoice.title')}</h1>
        <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
          {t('launchChoice.body', { session: ownLabel, launch: launchLabel })}
        </p>
        {phase === 'failed' && (
          <p role="alert" className="text-sm text-[color:var(--brand-muted-foreground)]">
            {t('launchChoice.failed')}
          </p>
        )}
        <button
          type="button"
          data-launch-choice-switch=""
          disabled={phase === 'switching'}
          onClick={() => void switchAccount()}
          className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
        >
          {t('launchChoice.switch', { name: launchLabel })}
        </button>
        <button
          type="button"
          data-launch-choice-stay=""
          disabled={phase === 'switching'}
          onClick={onStay}
          className={`${BUTTON} text-[color:var(--brand-muted-foreground)]`}
        >
          {t('launchChoice.stay', { name: ownLabel })}
        </button>
      </div>
    </div>
  )
}
