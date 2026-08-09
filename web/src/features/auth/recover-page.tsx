import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Send, MessageCircle, Mail, AlertTriangle } from 'lucide-react'
import { NetworkBg } from '@/components/ui/network-bg'
import { StadiumButton } from '@/components/ui/stadium-button'
import { recoverPassword, type RecoverResponse } from '@/lib/api-client'
import { GuestSupportLink } from '@/features/support/guest-support-link'
import { AxiosError } from 'axios'

// Same gate as the sign-in form: autofocus on a touch device raises the iOS
// keyboard mid-entrance (viewport shrink vs. mount motion + focus zoom).
const autoFocusFinePointer =
  typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

type RecoveryState = 'form' | 'result'

export default function RecoverPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [state, setState] = useState<RecoveryState>('form')
  const [result, setResult] = useState<RecoverResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryAfter, setRetryAfter] = useState<number | null>(null)

  const mutation = useMutation({
    mutationFn: recoverPassword,
    onSuccess: (data) => {
      setResult(data)
      setState('result')
      setError(null)
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      if (err.response?.status === 429) {
        const retryHeader = err.response.headers['retry-after']
        const seconds = retryHeader ? parseInt(retryHeader, 10) : 60
        setRetryAfter(seconds)
        setError(t('auth.recover.rateLimited', { seconds }))

        // Countdown
        const interval = setInterval(() => {
          setRetryAfter((prev) => {
            if (prev === null || prev <= 1) {
              clearInterval(interval)
              setError(null)
              return null
            }
            const next = prev - 1
            setError(t('auth.recover.rateLimited', { seconds: next }))
            return next
          })
        }, 1000)
      } else {
        setError(err.response?.data?.message || t('auth.recover.error'))
      }
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = username.trim()
    if (!trimmed) {
      setError(t('auth.recover.usernameRequired'))
      return
    }
    setError(null)
    mutation.mutate(trimmed)
  }

  function getResultIcon() {
    if (!result) return null
    switch (result.method) {
      case 'telegram':
        return <MessageCircle className="h-8 w-8 text-blue-400" />
      case 'email':
        return <Mail className="h-8 w-8 text-amber-400" />
      case 'none':
        return <AlertTriangle className="h-8 w-8 text-red-400" />
    }
  }

  function getResultMessage() {
    if (!result) return ''
    switch (result.method) {
      case 'telegram':
        return t('auth.recover.telegramSent')
      case 'email':
        return t('auth.recover.emailSuggested')
      case 'none':
        return t('auth.recover.noMethod')
    }
  }

  function getResultBorderColor() {
    if (!result) return 'border-[color:var(--color-border-soft)]'
    switch (result.method) {
      case 'telegram':
        return 'border-blue-500/30'
      case 'email':
        return 'border-amber-500/30'
      case 'none':
        return 'border-red-500/30'
    }
  }

  function getResultBgColor() {
    if (!result) return 'theme-skeleton'
    switch (result.method) {
      case 'telegram':
        return 'bg-blue-500/5'
      case 'email':
        return 'bg-amber-500/5'
      case 'none':
        return 'bg-red-500/5'
    }
  }

  return (
    // Own scroll container: html/body/#root are `100dvh; overflow:hidden`, and
    // the iOS keyboard shrinks only the visual viewport — without an inner
    // scroller WebKit jerks the layout viewport to reveal the focused input.
    <div className="scroll-area entry-scroller relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-5">
      <NetworkBg intensity="medium" />

      {/* Opacity-only entrance: the glass input inside carries backdrop-filter,
          and a y-slide re-blurs its backdrop every frame on WebKit. */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8"
      >
        {/* Header */}
        <div className="mb-8 text-center">
          <div
            className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(244,63,94,0.3) 0%, transparent 70%)',
              boxShadow: '0 0 40px rgba(244,63,94,0.3)',
            }}
          >
            <span className="text-3xl">🔑</span>
          </div>
          <h1 className="text-2xl font-bold text-[color:var(--brand-foreground)]">
            {t('auth.recover.title')}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--brand-muted-foreground)]">
            {t('auth.recover.description')}
          </p>
        </div>

        {state === 'form' ? (
          /* ── Recovery Form ── */
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('auth.recover.usernamePlaceholder')}
                autoComplete="username"
                autoFocus={autoFocusFinePointer}
                className="glass-input w-full rounded-xl px-4 py-3 text-sm"
              />
            </div>

            {/* Error display */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
              >
                {error}
              </motion.div>
            )}

            <StadiumButton
              type="submit"
              fullWidth
              size="lg"
              loading={mutation.isPending}
              disabled={retryAfter !== null}
              icon={<Send className="h-4 w-4" />}
            >
              {mutation.isPending
                ? t('auth.recover.submitting')
                : t('auth.recover.submit')}
            </StadiumButton>
          </form>
        ) : (
          /* ── Result Display ── */
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
            className={`rounded-2xl border ${getResultBorderColor()} ${getResultBgColor()} p-6`}
          >
            <div className="flex flex-col items-center gap-4 text-center">
              {getResultIcon()}
              <p className="text-sm leading-relaxed text-[color:var(--brand-foreground)]">
                {getResultMessage()}
              </p>
            </div>
          </motion.div>
        )}

        {/* Back to sign-in link */}
        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => navigate('/sign-in')}
            className="inline-flex items-center gap-1.5 text-sm text-[color:var(--brand-muted-foreground)] transition-colors hover:text-[color:var(--brand-foreground)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('auth.recover.backToSignIn')}
          </button>
          <div className="mt-4 flex justify-center">
            <GuestSupportLink />
          </div>
        </div>
      </motion.div>
    </div>
  )
}
