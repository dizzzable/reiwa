import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ShieldCheck, Eye, EyeOff, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NetworkBg } from '@/components/ui/network-bg'
import { BrandLogo } from '@/components/ui/brand-logo'
import { SESSION_QUERY_KEY, useSession } from '@/hooks/use-session'
import { claimAccount } from '@/lib/api-client'
import { hashPassword } from '@/lib/crypto'

// ── Validation (mirrors register-page rules) ─────────────────────────────────

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
 * ClaimPage — mandatory first-entry onboarding.
 *
 * A Telegram-first user (authenticated into a WebSession via the Mini App
 * bootstrap / magic-link) has a `User` but no `WebAccount`. Before reaching any
 * cabinet page they MUST set a login + password here, so they can also sign in
 * from a browser without Telegram. The gate (StealthLayout) keeps every other
 * protected route redirecting here until the claim succeeds; there is no skip.
 */
export default function ClaimPage() {
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
  const [serverError, setServerError] = useState<string | null>(null)

  // No session → send back through the entry router (which routes to sign-in).
  if (!isLoading && !isAuthenticated) {
    navigate('/bootstrap', { replace: true })
    return null
  }

  // Already claimed → never show the form again (Property 4).
  if (!isLoading && session?.webAccount) {
    navigate('/dashboard', { replace: true })
    return null
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
      await claimAccount(username, passwordHash)
      // Refetch the session so StealthLayout sees the linked WebAccount and
      // lets the user through.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      navigate('/dashboard', { replace: true })
    } catch (err: unknown) {
      setSubmitting(false)
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { status?: number; data?: { message?: string } } }
        const status = axiosErr.response?.status
        if (status === 409) {
          setUsernameError('required') // surface near the field
          setServerError(t('claim.errorUsernameTaken'))
        } else if (status === 400) {
          setServerError(t('claim.errorGeneric'))
        } else if (status === 429) {
          setServerError(t('claim.errorRateLimit'))
        } else if (status === 502 || status === 503) {
          setServerError(t('claim.errorServiceUnavailable'))
        } else {
          setServerError(t('claim.errorGeneric'))
        }
      } else {
        setServerError(t('claim.errorGeneric'))
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
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-(--brand-bg-primary) overflow-hidden px-4">
      <NetworkBg intensity="low" />

      <div className="relative z-10 w-full max-w-sm">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center mb-8"
        >
          <BrandLogo className="mb-5 h-10 w-auto" />
          <div
            className="flex h-16 w-16 items-center justify-center rounded-2xl mb-4"
            style={{
              background: 'radial-gradient(circle, rgba(244,63,94,0.2) 0%, transparent 70%)',
              boxShadow: '0 0 40px rgba(244,63,94,0.3)',
            }}
          >
            <ShieldCheck className="h-8 w-8 text-(--brand-primary)" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t('claim.title')}</h1>
          <p className="mt-2 text-center text-sm text-zinc-500">{t('claim.subtitle')}</p>
        </motion.div>

        <motion.form
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          onSubmit={handleSubmit}
          className="space-y-4"
          noValidate
        >
          {/* Login field */}
          <div>
            <label htmlFor="claim-username" className="block text-xs font-medium text-zinc-400 mb-1.5">
              {t('claim.usernameLabel')}
            </label>
            <input
              id="claim-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              placeholder={t('claim.usernamePlaceholder')}
              disabled={submitting}
              className={`w-full rounded-xl border bg-zinc-900/50 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors ${
                usernameError
                  ? 'border-red-500/50 focus:border-red-500'
                  : 'border-zinc-800 focus:border-(--brand-primary)/50'
              }`}
              aria-invalid={!!usernameError}
              aria-describedby="claim-username-error"
            />
            <div id="claim-username-error" className="mt-1 min-h-5" aria-live="polite">
              {usernameError && (
                <span className="text-xs text-red-400">
                  {t(`claim.usernameError.${usernameError}`)}
                </span>
              )}
            </div>
          </div>

          {/* Password field */}
          <div>
            <label htmlFor="claim-password" className="block text-xs font-medium text-zinc-400 mb-1.5">
              {t('claim.passwordLabel')}
            </label>
            <div className="relative">
              <input
                id="claim-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(e) => handlePasswordChange(e.target.value)}
                placeholder={t('claim.passwordPlaceholder')}
                disabled={submitting}
                className={`w-full rounded-xl border bg-zinc-900/50 px-4 py-3 pr-12 text-sm text-white placeholder-zinc-600 outline-none transition-colors ${
                  passwordError
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-zinc-800 focus:border-(--brand-primary)/50'
                }`}
                aria-invalid={!!passwordError}
                aria-describedby="claim-password-error"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                aria-label={showPassword ? t('claim.hidePassword') : t('claim.showPassword')}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div id="claim-password-error" className="mt-1 min-h-5" aria-live="polite">
              {passwordError && (
                <span className="text-xs text-red-400">
                  {t(`claim.passwordError.${passwordError}`)}
                </span>
              )}
            </div>
          </div>

          {/* Server error */}
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

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting || !!usernameError || !!passwordError || !username || !password}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-(--brand-primary) py-3.5 text-sm font-semibold text-(--brand-primary-fg) transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('claim.submitting')}
              </>
            ) : (
              t('claim.submit')
            )}
          </button>
        </motion.form>
      </div>
    </div>
  )
}
