import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Send, MailCheck, Link2, AlertTriangle, KeyRound } from 'lucide-react'
import { NetworkBg } from '@/components/ui/network-bg'
import { AuthBackdrop } from '@/components/ui/auth-backdrop'
import { StadiumButton } from '@/components/ui/stadium-button'
import { PressPlate } from '@/components/ui/press-plate'
import { resolveBrandLogo } from '@/types/branding'
import { resolveBrandMarkGlow } from '@/components/ui/brand-mark-glow'
import { useBranding } from '@/lib/branding-provider'
import { useSubscriptionLinkRecovery } from '@/lib/use-access-mode'
import { GuestSupportLink } from '@/features/support/guest-support-link'
import { requestPasswordReset, type RecoverAnswer } from './password-reset-api'

// Same gate as the sign-in form: autofocus on a touch device raises the iOS
// keyboard mid-entrance (viewport shrink vs. mount motion + focus zoom).
const autoFocusFinePointer =
  typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

/**
 * «Забыли пароль?»
 *
 * The customer types a login or the e-mail verified on the account; the panel
 * sends a reset link to the account's Telegram and/or e-mail. What this page
 * shows afterwards is the SAME for every login — it cannot tell anybody whether
 * a login exists or where it can be reached. It used to show a message per
 * channel ("a confirmation was sent to your Telegram") while nothing was sent.
 *
 * Below the form, the ways on for somebody the form cannot help:
 *   - forgot the login, has Telegram → the bot sends the link and names the
 *     login (`t.me/<bot>?start=pwreset`);
 *   - no access to Telegram or e-mail → recovery by the login alone
 *     (`/recover/subscription`, which asks for the VPN subscription link too
 *     when the panel is an older one) when the operator has it on
 *     («Восстановление пароля по логину»), and support for the rest.
 */
export default function RecoverPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { branding, botUsername } = useBranding()
  // Offered only when the operator's switch says so — off, unknown and a
  // panel without the switch all hide it.
  const subscriptionRecovery = useSubscriptionLinkRecovery()
  const [identifier, setIdentifier] = useState('')
  const [answer, setAnswer] = useState<RecoverAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [retryAfter, setRetryAfter] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (retryAfter <= 0) {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }
    timerRef.current = setInterval(() => {
      setRetryAfter((previous) => (previous <= 1 ? 0 : previous - 1))
    }, 1000)
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [retryAfter > 0])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting || retryAfter > 0) return
    const trimmed = identifier.trim()
    if (trimmed.length === 0) {
      setError(t('auth.recover.identifierRequired'))
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      setAnswer(await requestPasswordReset(trimmed))
    } catch (err: unknown) {
      const response = (err as { response?: { status?: number; headers?: Record<string, string>; data?: { retryAfter?: number } } })
        ?.response
      if (response?.status === 429) {
        const header = Number.parseInt(response.headers?.['retry-after'] ?? '', 10)
        const seconds =
          typeof response.data?.retryAfter === 'number' && response.data.retryAfter > 0
            ? response.data.retryAfter
            : Number.isFinite(header) && header > 0
              ? header
              : 60
        setRetryAfter(seconds)
      } else {
        setError(t('auth.recover.error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const telegramShortcut =
    typeof botUsername === 'string' && botUsername.length > 0
      ? `https://t.me/${botUsername.replace(/^@/, '')}?start=pwreset`
      : null

  // The light on the key comes from the SAME source as the brand mark's halo: a
  // chain of `drop-shadow`s computed from the glyph's own alpha, mixed from
  // `--brand-primary`, with the operator's `brandLogo.glow` deciding how strong
  // it is (`brand-mark-glow.ts`). The key is lit along its own outline instead
  // of sitting in a ring of light — the same defect the logo tile had.
  const keyGlow = resolveBrandMarkGlow({
    frame: 'glass',
    glow: resolveBrandLogo(branding.brandLogo).glow,
  })

  return (
    // Own scroll container: html/body/#root are `100dvh; overflow:hidden`, and
    // the iOS keyboard shrinks only the visual viewport — without an inner
    // scroller WebKit jerks the layout viewport to reveal the focused input.
    <div className="scroll-area entry-scroller relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-5">
      <NetworkBg intensity="medium" />
      <AuthBackdrop />

      {/* ONE SHEET FOR THE WHOLE READING COLUMN. Before, only the input was
          glass: the heading, the caption, the Telegram line and the back link
          sat straight on the operator's background and drowned in a bright
          photo. The captions are grouped by meaning, not one panel each — the
          form and its heading on this sheet, the "no access" notice on a second
          one below (it answers a different question: what to do instead). */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 py-8"
      >
        <div className="entry-panel w-full px-5 py-6">
          {/* Header. The mark of this screen is a plain key glyph whose light
              traces the glyph (see `keyGlow`), not an emoji inside a glowing
              circle: a circular bloom lights the BOX every time, whatever sits in
              it, which is exactly what the owner read as «подсвечивается кругом». */}
          <div className="mb-6 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center">
              <KeyRound aria-hidden className="h-9 w-9 text-(--brand-ink-text)" style={{ filter: keyGlow }} />
            </div>
            <h1 className="text-2xl font-bold text-[color:var(--brand-foreground)]">
              {t('auth.recover.title')}
            </h1>
            <p className="mt-2 text-sm text-[color:var(--brand-muted-foreground)]">
              {t('auth.recover.description')}
            </p>
          </div>

          {answer === null ? (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate data-testid="recover-form">
              <div>
                <label htmlFor="recover-identifier" className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]">
                  {t('auth.recover.identifierLabel')}
                </label>
                <input
                  id="recover-identifier"
                  name="username"
                  type="text"
                  value={identifier}
                  onChange={(event) => {
                    setIdentifier(event.target.value)
                    setError(null)
                  }}
                  placeholder={t('auth.recover.identifierPlaceholder')}
                  autoComplete="username"
                  autoFocus={autoFocusFinePointer}
                  className="glass-input w-full rounded-xl px-4 py-3 text-sm"
                />
              </div>

              {(error !== null || retryAfter > 0) && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
                  role="alert"
                >
                  {retryAfter > 0 ? t('auth.recover.rateLimited', { seconds: retryAfter }) : error}
                </motion.div>
              )}

              {/* Same press + holographic torch as the sign-in and register CTAs:
                  «Получить ссылку» is the primary action of this screen and must
                  not be the only submit in the flow that sits flat. */}
              <PressPlate className="w-full">
                <StadiumButton
                  type="submit"
                  fullWidth
                  size="lg"
                  loading={submitting}
                  disabled={retryAfter > 0}
                  watermark={branding.brandName}
                  icon={<Send className="h-4 w-4" />}
                >
                  {submitting ? t('auth.recover.submitting') : t('auth.recover.submit')}
                </StadiumButton>
              </PressPlate>
            </form>
          ) : (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[var(--color-surface)] p-6"
              data-testid="recover-answer"
              data-status={answer.status}
            >
              <div className="flex flex-col items-center gap-3 text-center">
                {answer.status === 'accepted' ? (
                  <MailCheck className="h-8 w-8 text-(--brand-ink)" />
                ) : (
                  <AlertTriangle className="h-8 w-8 text-amber-400" />
                )}
                <p className="text-sm leading-relaxed text-[color:var(--brand-foreground)]">
                  {answer.status === 'accepted' ? t('auth.recover.sent') : t('auth.recover.unavailable')}
                </p>
                {answer.status === 'accepted' && (
                  <p className="text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.recover.sentHint')}</p>
                )}
              </div>
            </motion.div>
          )}

          {/* Forgot the login: the bot knows who is asking. */}
          {telegramShortcut !== null && (
            <div className="mt-5 space-y-2 text-center">
              <p className="text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.recover.telegramShortcut')}</p>
              <a
                href={telegramShortcut}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-(--brand-ink-text) hover:brightness-110"
                data-testid="recover-telegram-shortcut"
              >
                <Send className="h-3.5 w-3.5" />
                {t('auth.recover.telegramShortcutAction')}
              </a>
            </div>
          )}

          {/* Back to sign-in — in the SAME shell as the support pill under the
              second sheet (`.support-glass`): a capsule only as wide as its
              caption, on the sheet's own glass. Both are ways OFF this form, so
              they read as one kind of control, and the divider row that used to
              separate the back link from the form is gone with it — the pill
              carries its own rim. */}
          <div className="mt-5 flex justify-center">
            <button type="button" onClick={() => navigate('/sign-in')} className="support-glass gap-1.5">
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('auth.recover.backToSignIn')}
            </button>
          </div>
        </div>

        {/* No access to either channel: the subscription link when the
            operator allows it, support either way. Its own sheet, because it is
            a separate answer rather than part of the form. */}
        <div
          className="entry-panel w-full p-4 text-center"
          data-testid="recover-no-access"
        >
          <p className="text-sm font-medium text-[color:var(--brand-foreground)]">{t('auth.recover.noAccessTitle')}</p>
          {subscriptionRecovery.enabled ? (
            <>
              <p className="mt-1 text-xs text-[color:var(--brand-muted-foreground)]">
                {t(subscriptionRecovery.byLogin ? 'auth.recover.noAccessBodyLogin' : 'auth.recover.noAccessBody')}
              </p>
              <Link
                to="/recover/subscription"
                className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-(--brand-ink-text) hover:brightness-110"
              >
                <Link2 className="h-3.5 w-3.5" />
                {t(subscriptionRecovery.byLogin ? 'auth.recover.noAccessActionLogin' : 'auth.recover.noAccessAction')}
              </Link>
              <p className="mt-1 text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.recover.noAccessSupport')}</p>
            </>
          ) : (
            <p className="mt-1 text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.recover.noAccessSupportOnly')}</p>
          )}
          <div className="mt-3 flex justify-center">
            <GuestSupportLink />
          </div>
        </div>
      </motion.div>
    </div>
  )
}
