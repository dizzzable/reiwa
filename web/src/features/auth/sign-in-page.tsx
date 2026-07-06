import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { NetworkBg } from '@/components/ui/network-bg'
import { BrandLogo } from '@/components/ui/brand-logo'
import { StadiumButton } from '@/components/ui/stadium-button'
import { login } from '@/lib/api-client'
import { hashPassword } from '@/lib/crypto'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { ExternalAuthButtons } from './external-auth-buttons'
import { GuestSupportLink } from '@/features/support/guest-support-link'

export default function SignInPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [rateLimitSeconds, setRateLimitSeconds] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Surface an external-auth failure passed back by the BFF as `?error=...`
  // (denied / ext_state / ext_failed / ext_unavailable), then strip the param
  // so a refresh doesn't re-show it.
  useEffect(() => {
    const extError = searchParams.get('error')
    if (!extError) return
    setError(extError === 'denied' ? t('auth.errorExternalDenied') : t('auth.errorExternal'))
    searchParams.delete('error')
    setSearchParams(searchParams, { replace: true })
  }, [searchParams, setSearchParams, t])

  // Countdown timer for rate limiting
  useEffect(() => {
    if (rateLimitSeconds <= 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }

    timerRef.current = setInterval(() => {
      setRateLimitSeconds((prev) => {
        if (prev <= 1) {
          setError(null)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [rateLimitSeconds])

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()

      // Don't submit if rate limited
      if (rateLimitSeconds > 0) return

      // Basic client-side validation
      const trimmedUsername = username.trim()
      if (!trimmedUsername || !password) {
        setError(t('auth.invalidCredentials'))
        return
      }

      setError(null)
      setIsSubmitting(true)

      try {
        // SHA-256 hash the password before sending
        const passwordHash = await hashPassword(password)

        const response = await login({
          username: trimmedUsername,
          passwordHash,
        })

        if (response.success) {
          // Invalidate session query to refetch
          await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })

          if (response.requiresPasswordChange) {
            // Block access to protected routes — redirect to password change
            navigate('/change-password', { replace: true })
          } else {
            // Normal sign-in — redirect to dashboard or specified URL
            navigate(response.redirectUrl || '/dashboard', { replace: true })
          }
        }
      } catch (err: unknown) {
        if (isAxiosError(err) && err.response?.status === 429) {
          // Rate limited — extract Retry-After header
          const retryAfter = err.response.headers?.['retry-after']
          const seconds = retryAfter ? parseInt(retryAfter, 10) : 60
          setRateLimitSeconds(isNaN(seconds) ? 60 : seconds)
          setError(t('auth.rateLimited', { seconds: isNaN(seconds) ? 60 : seconds }))
        } else {
          // Generic error — never reveal which field is wrong
          setError(t('auth.invalidCredentials'))
        }
      } finally {
        setIsSubmitting(false)
      }
    },
    [username, password, rateLimitSeconds, navigate, queryClient, t],
  )

  const isFormDisabled = isSubmitting || rateLimitSeconds > 0

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-(--brand-bg-primary) px-4">
      <NetworkBg intensity="medium" />

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-8">
        {/* Logo */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', damping: 20, stiffness: 200 }}
        >
          <div
            className="flex h-20 w-20 items-center justify-center rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur-xl"
            style={{ boxShadow: '0 0 60px var(--color-brand-glow)' }}
          >
            <BrandLogo className="h-11 w-11" />
          </div>
        </motion.div>

        {/* Title */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="text-center"
        >
          <h1 className="text-2xl font-bold tracking-wide text-white">
            {t('auth.signInTitle')}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {t('auth.signInDescription')}
          </p>
        </motion.div>

        {/* Form */}
        <motion.form
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          onSubmit={handleSubmit}
          className="flex w-full flex-col gap-4"
          noValidate
        >
          {/* Username field */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="signin-username" className="text-sm font-medium text-zinc-400">
              {t('auth.username')}
            </label>
            <input
              id="signin-username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isFormDisabled}
              placeholder={t('auth.usernamePlaceholder')}
              className="h-11 w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 text-sm text-white placeholder:text-zinc-600 outline-none transition-colors focus:border-(--brand-primary)/50 focus:ring-1 focus:ring-(--brand-primary)/30 disabled:opacity-50"
            />
          </div>

          {/* Password field */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="signin-password" className="text-sm font-medium text-zinc-400">
              {t('auth.password')}
            </label>
            <input
              id="signin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isFormDisabled}
              placeholder={t('auth.passwordPlaceholder')}
              className="h-11 w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 text-sm text-white placeholder:text-zinc-600 outline-none transition-colors focus:border-(--brand-primary)/50 focus:ring-1 focus:ring-(--brand-primary)/30 disabled:opacity-50"
            />
          </div>

          {/* Error display */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm text-red-400"
              role="alert"
            >
              {rateLimitSeconds > 0
                ? t('auth.rateLimited', { seconds: rateLimitSeconds })
                : error}
            </motion.div>
          )}

          {/* Submit button */}
          <StadiumButton
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={isSubmitting}
            disabled={isFormDisabled}
          >
            {isSubmitting ? t('auth.signingIn') : t('auth.signInButton')}
          </StadiumButton>
        </motion.form>

        {/* External sign-in (renders nothing when no providers are enabled) */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.32 }}
          className="w-full"
        >
          <ExternalAuthButtons />
        </motion.div>

        {/* Links */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="flex flex-col items-center gap-2 text-sm"
        >
          <Link
            to="/recover"
            className="text-zinc-500 transition-colors hover:text-(--brand-primary)"
          >
            {t('auth.forgotPassword')}
          </Link>
          <span className="text-zinc-600">
            {t('auth.noAccount')}{' '}
            <Link
              to="/register"
              className="text-(--brand-primary) transition-colors hover:brightness-110"
            >
              {t('auth.register')}
            </Link>
          </span>
          <GuestSupportLink />
        </motion.div>
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface AxiosErrorLike {
  response?: {
    status: number
    headers?: Record<string, string>
    data?: unknown
  }
}

function isAxiosError(err: unknown): err is AxiosErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as AxiosErrorLike).response?.status === 'number'
  )
}
