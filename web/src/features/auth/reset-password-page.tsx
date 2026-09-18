import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { CheckCircle2, Eye, EyeOff, KeyRound, TimerOff } from 'lucide-react'

import { NetworkBg } from '@/components/ui/network-bg'
import { StadiumButton } from '@/components/ui/stadium-button'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { hashPassword } from '@/lib/crypto'
import { GuestSupportLink } from '@/features/support/guest-support-link'
import {
  inspectResetLink,
  readResetHandoff,
  readResetTokenFromHash,
  readResetTokenFromSearch,
  resetPassword,
  type SignInHandoffState,
} from './password-reset-api'
import { SaveCredentialsScreen, type SavedCredentials } from './save-credentials'

type Phase = 'checking' | 'form' | 'expired' | 'used' | 'missing' | 'changed'

/** Where the token came from, captured once on the first render. */
interface ResetSource {
  readonly token: string
  readonly login: string
}

/**
 * `/reset-password` — set a new password with a single-use link.
 *
 * The token arrives three ways: `#token=` in the link from e-mail or behind the
 * bot's URL button; `?token=` behind the Mini App button, whose fragment
 * belongs to Telegram; or the router's navigation state from recovery by
 * subscription link. Whichever, it is read ONCE into this page's memory and
 * immediately erased from the address bar and from the history entry, so it
 * does not stay in the browser's history or leave in a Referer. A reload after
 * that shows "incomplete link" — the link itself still works if opened again.
 *
 * The link is inspected before the form appears, so an expired or used link
 * says so before anybody types a password, and the page can name the login.
 */
export default function ResetPasswordPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()

  const [source] = useState<ResetSource | null>(() => {
    const handoff = readResetHandoff(location.state)
    if (handoff !== null) return { token: handoff.resetToken, login: handoff.login }
    const token = readResetTokenFromHash(location.hash) ?? readResetTokenFromSearch(location.search)
    return token === null ? null : { token, login: '' }
  })
  const [phase, setPhase] = useState<Phase>(source === null ? 'missing' : 'checking')
  const [login, setLogin] = useState(source?.login ?? '')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState<SavedCredentials | null>(null)

  // Erase the token from the address and the history entry. Once: the source
  // above has already taken it into memory.
  useEffect(() => {
    if (location.search.length > 0 || location.hash.length > 0 || location.state !== null) {
      navigate('/reset-password', { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (source === null) return
    let cancelled = false
    inspectResetLink(source.token)
      .then((answer) => {
        if (cancelled) return
        if (answer.status === 'valid') {
          setLogin(answer.login)
          setPhase('form')
        } else {
          setPhase(answer.status)
        }
      })
      .catch(() => {
        // Could not ask. The form still works; the submit will say what the link is.
        if (!cancelled) setPhase('form')
      })
    return () => {
      cancelled = true
    }
  }, [source])

  const lengthValid = password.length >= 8 && password.length <= 128
  const matches = password === repeat

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (source === null || submitting) return
    if (!lengthValid) {
      setError(t('auth.reset.lengthError'))
      return
    }
    if (!matches) {
      setError(t('auth.reset.mismatch'))
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const passwordHash = await hashPassword(password)
      const answer = await resetPassword(source.token, passwordHash)
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      setSaved({ login: answer.login || login, password })
    } catch (err: unknown) {
      const response = (
        err as {
          response?: { status?: number; data?: { code?: string; retryAfter?: number; login?: unknown } }
        }
      )?.response
      const code = response?.data?.code
      if (code === 'RESET_LINK_USED') {
        setPhase('used')
      } else if (code === 'RESET_LINK_EXPIRED') {
        setPhase('expired')
      } else if (code === 'SESSION_FAILED') {
        // The password IS changed — only the automatic sign-in did not happen.
        // "Try again" would spend nothing but a spent link.
        const answeredLogin = response?.data?.login
        if (typeof answeredLogin === 'string' && answeredLogin.length > 0) setLogin(answeredLogin)
        setPhase('changed')
      } else if (response?.status === 429) {
        const retryAfter = response.data?.retryAfter
        setError(t('auth.reset.rateLimited', { seconds: typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : 60 }))
      } else if (response?.status === 503) {
        setError(t('auth.reset.unavailable'))
      } else {
        setError(t('auth.reset.error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (saved !== null) {
    return <SaveCredentialsScreen login={saved.login} password={saved.password} continueTo="/dashboard" />
  }

  const signInWithNewPassword = () => {
    const state: SignInHandoffState = { login }
    navigate('/sign-in', { replace: true, state })
  }

  const deadEnd =
    phase === 'expired'
      ? { title: t('auth.reset.expiredTitle'), body: t('auth.reset.expiredBody') }
      : phase === 'used'
        ? { title: t('auth.reset.usedTitle'), body: t('auth.reset.usedBody') }
        : phase === 'missing'
          ? { title: t('auth.reset.missingTitle'), body: t('auth.reset.missingBody') }
          : null

  return (
    <div className="scroll-area entry-scroller relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-4">
      <NetworkBg intensity="medium" />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8"
      >
        {phase === 'changed' ? (
          <div className="space-y-5 text-center" data-testid="reset-changed">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10">
              <CheckCircle2 className="h-7 w-7 text-emerald-400" />
            </div>
            <h1 className="text-xl font-bold text-[color:var(--brand-foreground)]">{t('auth.reset.changedTitle')}</h1>
            {login.length > 0 && (
              <p className="text-sm text-[color:var(--brand-muted-foreground)]" data-testid="reset-changed-login">
                {t('auth.reset.changedLogin', { login })}
              </p>
            )}
            <StadiumButton type="button" variant="primary" fullWidth onClick={signInWithNewPassword}>
              {t('auth.reset.signIn')}
            </StadiumButton>
          </div>
        ) : deadEnd !== null ? (
          <div className="space-y-5 text-center" data-testid="reset-dead-end" data-phase={phase}>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10">
              <TimerOff className="h-7 w-7 text-red-400" />
            </div>
            <h1 className="text-xl font-bold text-[color:var(--brand-foreground)]">{deadEnd.title}</h1>
            <p className="text-sm text-[color:var(--brand-muted-foreground)]">{deadEnd.body}</p>
            <StadiumButton type="button" variant="primary" fullWidth onClick={() => navigate('/recover')}>
              {t('auth.reset.requestNew')}
            </StadiumButton>
            <div className="flex justify-center">
              <GuestSupportLink />
            </div>
          </div>
        ) : phase === 'checking' ? (
          <p className="text-center text-sm text-[color:var(--brand-muted-foreground)]" data-testid="reset-checking">
            {t('auth.reset.checking')}
          </p>
        ) : (
          <>
            <div className="mb-8 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-(--brand-primary)/10">
                <KeyRound className="h-7 w-7 text-(--brand-primary)" />
              </div>
              <h1 className="text-2xl font-bold text-[color:var(--brand-foreground)]">{t('auth.reset.title')}</h1>
              {login.length > 0 && (
                <p className="mt-2 text-sm text-[color:var(--brand-muted-foreground)]" data-testid="reset-login">
                  {t('auth.reset.subtitle', { login })}
                </p>
              )}
            </div>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate data-testid="reset-form">
              {/* The account this password belongs to, for a password manager
                  saving the new one — it is otherwise not on the page. */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={login}
                readOnly
                hidden
                tabIndex={-1}
                aria-hidden="true"
              />
              <div>
                <label htmlFor="reset-password" className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]">
                  {t('auth.reset.newPassword')}
                </label>
                <div className="relative">
                  <input
                    id="reset-password"
                    name="new-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setError(null)
                    }}
                    placeholder={t('auth.reset.newPasswordPlaceholder')}
                    disabled={submitting}
                    className="glass-input w-full rounded-xl px-4 py-3 pr-12 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--brand-muted-foreground)] transition-colors hover:text-[color:var(--brand-foreground)]"
                    aria-label={showPassword ? t('auth.reset.hidePassword') : t('auth.reset.showPassword')}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {password.length > 0 && !lengthValid && (
                  <p className="mt-1.5 text-xs text-red-400">{t('auth.reset.lengthError')}</p>
                )}
              </div>
              <div>
                <label htmlFor="reset-password-repeat" className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]">
                  {t('auth.reset.repeatPassword')}
                </label>
                <input
                  id="reset-password-repeat"
                  name="new-password-repeat"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(event) => {
                    setRepeat(event.target.value)
                    setError(null)
                  }}
                  placeholder={t('auth.reset.repeatPasswordPlaceholder')}
                  disabled={submitting}
                  className="glass-input w-full rounded-xl px-4 py-3 text-sm"
                />
                {repeat.length > 0 && !matches && (
                  <p className="mt-1.5 text-xs text-red-400">{t('auth.reset.mismatch')}</p>
                )}
              </div>
              {error !== null && (
                <div
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
                  role="alert"
                  data-testid="reset-error"
                >
                  {error}
                </div>
              )}
              <StadiumButton
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={submitting}
                disabled={!lengthValid || !matches || submitting}
              >
                {submitting ? t('auth.reset.submitting') : t('auth.reset.submit')}
              </StadiumButton>
            </form>
            <div className="mt-6 text-center">
              <Link to="/sign-in" className="text-sm text-[color:var(--brand-muted-foreground)] hover:text-[color:var(--brand-foreground)]">
                {t('auth.recover.backToSignIn')}
              </Link>
            </div>
          </>
        )}
      </motion.div>
    </div>
  )
}
