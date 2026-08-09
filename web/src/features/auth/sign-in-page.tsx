import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { NetworkBg } from '@/components/ui/network-bg'
import { EntryBrandTile } from '@/components/ui/entry-brand-tile'
import { StadiumButton } from '@/components/ui/stadium-button'
import { login } from '@/lib/api-client'
import { hashPassword } from '@/lib/crypto'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { ExternalAuthButtons } from './external-auth-buttons'
import { GuestSupportLink } from '@/features/support/guest-support-link'

// Autofocusing the username field on a touch device raises the iOS keyboard in
// the middle of the mount animation (viewport shrink vs. entrance motion, plus
// an instant focus-zoom). Only a precise-pointer device — desktop, where a
// hardware keyboard is already attached — keeps the convenience.
const autoFocusFinePointer =
  typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

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

  // A document-navigation auth flow (for example, OAuth in Telegram's
  // browser) is redirected here by the server on 429. Preserve the same
  // countdown UX as the regular XHR sign-in flow.
  useEffect(() => {
    const rawRetryAfter = searchParams.get('retry_after')
    if (searchParams.get('rate_limited') !== '1' || !rawRetryAfter) return
    const seconds = Number.parseInt(rawRetryAfter, 10)
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return
    setRateLimitSeconds(seconds)
    setError(t('auth.rateLimited', { seconds }))
    searchParams.delete('rate_limited')
    searchParams.delete('retry_after')
    setSearchParams(searchParams, { replace: true })
  }, [searchParams, setSearchParams, t])

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
          // Rate limited — extract retryAfter from response body
          const retryAfter = err.response.data?.retryAfter
          const seconds = typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : 60
          setRateLimitSeconds(seconds)
          setError(t('auth.rateLimited', { seconds }))
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
    // The page is its own scroller: html/body/#root are locked to
    // `100dvh; overflow:hidden`, and the iOS keyboard shrinks only the visual
    // viewport — with no inner scroll container WebKit jerks the layout
    // viewport to reveal the focused input. `min-h-full` + justify-center on
    // the inner column keeps content centered while the keyboard is closed.
    <div className="scroll-area entry-scroller relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-4">
      <NetworkBg intensity="medium" />

      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-sm flex-col items-center justify-center gap-8 py-8">
        {/* Logo */}
        <EntryBrandTile />

        {/* Title */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="text-center"
        >
          <h1 className="text-2xl font-bold tracking-wide text-[color:var(--brand-foreground)]">
            {t('auth.signInTitle')}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--brand-muted-foreground)]">
            {t('auth.signInDescription')}
          </p>
        </motion.div>

        {/* Form. Opacity-only entrance: the glass inputs inside carry
            backdrop-filter, and moving them (y-slide) re-blurs their backdrop
            every frame on WebKit. */}
        <motion.form
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
          onSubmit={handleSubmit}
          className="flex w-full flex-col gap-4"
          noValidate
        >
          {/* Username field */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="signin-username" className="text-sm font-medium text-[color:var(--brand-muted-foreground)]">
              {t('auth.username')}
            </label>
            <input
              id="signin-username"
              type="text"
              autoComplete="username"
              autoFocus={autoFocusFinePointer}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isFormDisabled}
              placeholder={t('auth.usernamePlaceholder')}
              className="glass-input h-11 w-full rounded-xl px-4 text-sm disabled:opacity-50"
            />
          </div>

          {/* Password field */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="signin-password" className="text-sm font-medium text-[color:var(--brand-muted-foreground)]">
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
              className="glass-input h-11 w-full rounded-xl px-4 text-sm disabled:opacity-50"
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
            className="text-[color:var(--brand-muted-foreground)] transition-colors hover:text-(--brand-primary)"
          >
            {t('auth.forgotPassword')}
          </Link>
          <span className="text-[color:var(--brand-muted-foreground)]">
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
    data?: {
      retryAfter?: number
      [key: string]: unknown
    }
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
