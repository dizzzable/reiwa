import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ShieldCheck, Eye, EyeOff, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NetworkBg } from '@/components/ui/network-bg'
import { BrandLogo } from '@/components/ui/brand-logo'
import { SESSION_QUERY_KEY, useSession } from '@/hooks/use-session'
import { finishExternalSetup, signOut } from '@/lib/api-client'
import { hashPassword } from '@/lib/crypto'

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/

function validateUsername(value: string): string | null {
  if (!value) return 'required'
  if (value.length < 3) return 'tooShort'
  if (value.length > 32) return 'tooLong'
  if (!USERNAME_REGEX.test(value)) return 'invalidChars'
  return null
}

function validatePassword(value: string): string | null {
  if (!value) return 'required'
  if (value.length < 8) return 'tooShort'
  if (value.length > 128) return 'tooLong'
  return null
}

/**
 * FinishSetupPage — mandatory step after an external (social) registration.
 *
 * A user who signed up via Google/Yandex/Mail.ru/Telegram has a `User` + a
 * shell `WebAccount` (email attached, no login/password). Login + password stay
 * mandatory (so the Mini App entry works later without a merge), so this page
 * forces them to choose credentials before reaching any cabinet route. The
 * StealthLayout gate keeps every protected route redirecting here until done.
 */
export default function FinishSetupPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { session, isLoading, isAuthenticated } = useSession()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  // No session → back through the entry router.
  if (!isLoading && !isAuthenticated) {
    navigate('/bootstrap', { replace: true })
    return null
  }

  // Already has credentials → never show this again.
  if (!isLoading && session?.webAccount?.login) {
    navigate('/dashboard', { replace: true })
    return null
  }

  // Escape hatch: a user who already has an account (e.g. a web-first account
  // whose Telegram isn't linked yet, so external-auth couldn't auto-match it)
  // must be able to bail out of the mandatory finish-setup instead of being
  // trapped. Destroy the shell session and return to the sign-in form so they
  // can log into their real account (and link Telegram later from Settings).
  async function handleCancel() {
    setCancelling(true)
    try {
      await signOut()
    } catch {
      // Idempotent logout — ignore; we navigate away regardless.
    }
    queryClient.clear()
    navigate('/sign-in', { replace: true })
  }

  function handleUsernameChange(value: string) {
    setUsername(value)
    setServerError(null)
    setUsernameError(value ? validateUsername(value) : null)
  }

  function handlePasswordChange(value: string) {
    setPassword(value)
    setServerError(null)
    setPasswordError(value ? validatePassword(value) : null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const uError = validateUsername(username)
    const pError = validatePassword(password)
    setUsernameError(uError)
    setPasswordError(pError)
    if (uError || pError) return

    setSubmitting(true)
    setServerError(null)
    try {
      const passwordHash = await hashPassword(password)
      await finishExternalSetup({ username, passwordHash })
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      navigate('/dashboard', { replace: true })
    } catch (err: unknown) {
      setSubmitting(false)
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { status?: number; data?: { retryAfter?: number } } }
        const status = axiosErr.response?.status
        if (status === 409) {
          // Login already taken — almost always by the user's own existing
          // account. Guide them to sign in instead of a dead-end field error.
          setServerError(t('finishSetup.errorUsernameTaken'))
        } else if (status === 429) {
          const retryAfter = axiosErr.response?.data?.retryAfter
          const seconds = typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : 60
          setServerError(t('finishSetup.errorRateLimit', { seconds }))
        } else {
          setServerError(t('finishSetup.errorGeneric'))
        }
      } else {
        setServerError(t('finishSetup.errorGeneric'))
      }
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-(--brand-bg-primary)">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-(--brand-bg-primary) px-4">
      <NetworkBg intensity="low" />

      <div className="relative z-10 w-full max-w-sm">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 flex flex-col items-center"
        >
          <BrandLogo className="mb-5 h-10 w-auto" />
          <div
            className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
            style={{
              background: 'radial-gradient(circle, rgba(244,63,94,0.2) 0%, transparent 70%)',
              boxShadow: '0 0 40px rgba(244,63,94,0.3)',
            }}
          >
            <ShieldCheck className="h-8 w-8 text-(--brand-primary)" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t('finishSetup.title')}</h1>
          <p className="mt-2 text-center text-sm text-zinc-500">{t('finishSetup.subtitle')}</p>
        </motion.div>

        <motion.form
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          onSubmit={handleSubmit}
          className="space-y-4"
          noValidate
        >
          <div>
            <label htmlFor="finish-username" className="mb-1.5 block text-xs font-medium text-zinc-400">
              {t('finishSetup.usernameLabel')}
            </label>
            <input
              id="finish-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              placeholder={t('finishSetup.usernamePlaceholder')}
              disabled={submitting}
              className={`w-full rounded-xl border bg-zinc-900/50 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors ${
                usernameError ? 'border-red-500/50 focus:border-red-500' : 'border-zinc-800 focus:border-(--brand-primary)/50'
              }`}
              aria-invalid={!!usernameError}
            />
            <div className="mt-1 min-h-5" aria-live="polite">
              {usernameError && (
                <span className="text-xs text-red-400">{t(`finishSetup.usernameError.${usernameError}`)}</span>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="finish-password" className="mb-1.5 block text-xs font-medium text-zinc-400">
              {t('finishSetup.passwordLabel')}
            </label>
            <div className="relative">
              <input
                id="finish-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(e) => handlePasswordChange(e.target.value)}
                placeholder={t('finishSetup.passwordPlaceholder')}
                disabled={submitting}
                className={`w-full rounded-xl border bg-zinc-900/50 px-4 py-3 pr-12 text-sm text-white placeholder-zinc-600 outline-none transition-colors ${
                  passwordError ? 'border-red-500/50 focus:border-red-500' : 'border-zinc-800 focus:border-(--brand-primary)/50'
                }`}
                aria-invalid={!!passwordError}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-300"
                aria-label={showPassword ? t('finishSetup.hidePassword') : t('finishSetup.showPassword')}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="mt-1 min-h-5" aria-live="polite">
              {passwordError && (
                <span className="text-xs text-red-400">{t(`finishSetup.passwordError.${passwordError}`)}</span>
              )}
            </div>
          </div>

          {serverError && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400"
              role="alert"
            >
              {serverError}
            </motion.div>
          )}

          <button
            type="submit"
            disabled={submitting || !!usernameError || !!passwordError || !username || !password}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-(--brand-primary) py-3.5 text-sm font-semibold text-(--brand-primary-fg) transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('finishSetup.submitting')}
              </>
            ) : (
              t('finishSetup.submit')
            )}
          </button>

          {/* Escape hatch — sign out of the shell session and return to the
              sign-in form (for users who already have an account). */}
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting || cancelling}
            className="flex w-full items-center justify-center gap-2 py-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300 disabled:opacity-50"
          >
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : t('finishSetup.haveAccount')}
          </button>
        </motion.form>
      </div>
    </div>
  )
}
