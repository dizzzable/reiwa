import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { ArrowLeft, Link2, MailCheck } from 'lucide-react'

import { NetworkBg } from '@/components/ui/network-bg'
import { StadiumButton } from '@/components/ui/stadium-button'
import { GuestSupportLink } from '@/features/support/guest-support-link'
import { useSubscriptionLinkRecovery } from '@/lib/use-access-mode'
import { recoverBySubscription, type ResetHandoffState } from './password-reset-api'

/**
 * `/recover/subscription` — for an account with neither Telegram nor a
 * verified e-mail.
 *
 * The VPN subscription link (from the customer's app) is the proof. The login
 * only picks the account and adds friction — it is NOT a secret: the panel
 * names VPN profiles after it. So the panel lets this path set a password only
 * for an account that has no other way in; for any other it sends the ordinary
 * reset link to the account's Telegram or e-mail, and this page shows the
 * answer the "forgot password" form gives everybody. Every failed check gets
 * one answer, shown as it is — it never hints which half was wrong. A customer
 * who forgot the login as well cannot use this path, by design: it would turn
 * the page into a way to look a login up.
 *
 * On success the reset token goes to `/reset-password` in the router's
 * navigation state — memory, not the address bar.
 *
 * The operator can switch the path off («Восстановление пароля по ссылке
 * подписки»). Then — and against a panel that predates the switch — the page
 * says so and points to support instead of showing a form the panel refuses.
 */
export default function RecoverSubscriptionPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const policy = useSubscriptionLinkRecovery()
  const [link, setLink] = useState('')
  const [login, setLogin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sentToChannels, setSentToChannels] = useState(false)
  // Switched off while the page was open: the panel's own refusal.
  const [disabledByServer, setDisabledByServer] = useState(false)
  const off = !policy.isLoading && (!policy.enabled || disabledByServer)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    if (link.trim().length === 0 || login.trim().length === 0) {
      setError(t('auth.recoverSubscription.required'))
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const answer = await recoverBySubscription(link.trim(), login.trim())
      if (answer.status === 'verified') {
        const state: ResetHandoffState = { resetToken: answer.token, login: answer.login }
        navigate('/reset-password', { state })
      } else {
        setSentToChannels(true)
      }
    } catch (err: unknown) {
      const response = (err as { response?: { status?: number; data?: { code?: string; retryAfter?: number } } })
        ?.response
      if (response?.data?.code === 'NOT_VERIFIED') {
        setError(t('auth.recoverSubscription.notVerified'))
      } else if (response?.data?.code === 'RECOVERY_DISABLED') {
        setDisabledByServer(true)
      } else if (response?.status === 429) {
        const seconds = typeof response.data?.retryAfter === 'number' ? response.data.retryAfter : 3600
        setError(t('auth.recoverSubscription.rateLimited', { count: Math.max(1, Math.ceil(seconds / 60)) }))
      } else if (response?.status === 503) {
        setError(t('auth.recoverSubscription.unavailable'))
      } else {
        setError(t('auth.recoverSubscription.error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="scroll-area entry-scroller relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-5">
      <NetworkBg intensity="medium" />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8"
      >
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-(--brand-primary)/10">
            <Link2 className="h-7 w-7 text-(--brand-primary)" />
          </div>
          <h1 className="text-2xl font-bold text-[color:var(--brand-foreground)]">
            {off ? t('auth.recoverSubscription.disabledTitle') : t('auth.recoverSubscription.title')}
          </h1>
          <p
            className="mt-2 text-sm text-[color:var(--brand-muted-foreground)]"
            data-testid={off ? 'recover-subscription-disabled' : undefined}
          >
            {policy.isLoading
              ? t('auth.recoverSubscription.loading')
              : off
                ? t('auth.recoverSubscription.disabledBody')
                : t('auth.recoverSubscription.description')}
          </p>
        </div>

        {policy.isLoading || off ? null : sentToChannels ? (
          // The "forgot password" form's one answer, word for word: the
          // account has a channel, and the reset link went there.
          <div
            className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[var(--color-surface)] p-6"
            data-testid="recover-subscription-sent"
          >
            <div className="flex flex-col items-center gap-3 text-center">
              <MailCheck className="h-8 w-8 text-(--brand-primary)" />
              <p className="text-sm leading-relaxed text-[color:var(--brand-foreground)]">{t('auth.recover.sent')}</p>
              <p className="text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.recover.sentHint')}</p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate data-testid="recover-subscription-form">
            <div>
              <label htmlFor="recover-subscription-link" className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]">
                {t('auth.recoverSubscription.linkLabel')}
              </label>
              <textarea
                id="recover-subscription-link"
                name="subscription-link"
                rows={3}
                autoComplete="off"
                spellCheck={false}
                value={link}
                onChange={(event) => {
                  setLink(event.target.value)
                  setError(null)
                }}
                placeholder={t('auth.recoverSubscription.linkPlaceholder')}
                disabled={submitting}
                className="glass-input w-full resize-none rounded-xl px-4 py-3 font-mono text-xs"
              />
              <p className="mt-1.5 text-xs text-[color:var(--brand-muted-foreground)]">
                {t('auth.recoverSubscription.linkHint')}
              </p>
            </div>
            <div>
              <label htmlFor="recover-subscription-login" className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]">
                {t('auth.recoverSubscription.loginLabel')}
              </label>
              <input
                id="recover-subscription-login"
                name="username"
                type="text"
                autoComplete="username"
                value={login}
                onChange={(event) => {
                  setLogin(event.target.value)
                  setError(null)
                }}
                placeholder={t('auth.recoverSubscription.loginPlaceholder')}
                disabled={submitting}
                className="glass-input w-full rounded-xl px-4 py-3 text-sm"
              />
            </div>
            {error !== null && (
              <div
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
                role="alert"
                data-testid="recover-subscription-error"
              >
                {error}
              </div>
            )}
            <StadiumButton type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
              {submitting ? t('auth.recoverSubscription.submitting') : t('auth.recoverSubscription.submit')}
            </StadiumButton>
          </form>
        )}

        <div className="mt-6 space-y-3 text-center text-xs text-[color:var(--brand-muted-foreground)]">
          {!policy.isLoading && !off && (
            <>
              <p>{t('auth.recoverSubscription.lockedHint')}</p>
              <p>{t('auth.recoverSubscription.forgotLogin')}</p>
            </>
          )}
          <div className="flex justify-center">
            <GuestSupportLink />
          </div>
          <Link
            to="/recover"
            className="inline-flex items-center gap-1.5 text-sm transition-colors hover:text-[color:var(--brand-foreground)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('auth.recoverSubscription.back')}
          </Link>
        </div>
      </motion.div>
    </div>
  )
}
