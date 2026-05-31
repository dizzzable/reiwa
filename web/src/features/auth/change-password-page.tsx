import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { NetworkBg } from '@/components/ui/network-bg'
import { StadiumButton } from '@/components/ui/stadium-button'
import { hashPassword } from '@/lib/crypto'
import { changePasswordAuth } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth.store'

export default function ChangePasswordPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const newPasswordValid = newPassword.length >= 8 && newPassword.length <= 128
  const formValid = currentPassword.length > 0 && newPasswordValid

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!formValid || isSubmitting) return

    setError('')
    setIsSubmitting(true)

    try {
      const currentPasswordHash = await hashPassword(currentPassword)
      const newPasswordHash = await hashPassword(newPassword)

      await changePasswordAuth({ currentPasswordHash, newPasswordHash })

      // Clear the requiresPasswordChange flag
      useAuthStore.getState().clearRequiresPasswordChange()

      // Redirect to dashboard on success
      navigate('/dashboard', { replace: true })
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { message?: string } } }
        setError(axiosErr.response?.data?.message || t('changePassword.errorGeneric'))
      } else {
        setError(t('changePassword.errorGeneric'))
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-(--brand-bg-primary) overflow-hidden px-4">
      <NetworkBg intensity="medium" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 w-full max-w-sm"
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
          <h1 className="text-xl font-bold text-white">
            {t('changePassword.title')}
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            {t('changePassword.description')}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current password */}
          <div>
            <label
              htmlFor="current-password"
              className="mb-1.5 block text-xs font-medium text-zinc-400 uppercase tracking-wider"
            >
              {t('changePassword.currentPassword')}
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-(--brand-primary)/50 focus:ring-1 focus:ring-(--brand-primary)/30"
              placeholder={t('changePassword.currentPasswordPlaceholder')}
              disabled={isSubmitting}
            />
          </div>

          {/* New password */}
          <div>
            <label
              htmlFor="new-password"
              className="mb-1.5 block text-xs font-medium text-zinc-400 uppercase tracking-wider"
            >
              {t('changePassword.newPassword')}
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-(--brand-primary)/50 focus:ring-1 focus:ring-(--brand-primary)/30"
              placeholder={t('changePassword.newPasswordPlaceholder')}
              disabled={isSubmitting}
            />
            {newPassword.length > 0 && !newPasswordValid && (
              <p className="mt-1.5 text-xs text-red-400">
                {t('changePassword.passwordLengthError')}
              </p>
            )}
          </div>

          {/* Error message */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
            >
              {error}
            </motion.div>
          )}

          {/* Submit button */}
          <StadiumButton
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={isSubmitting}
            disabled={!formValid}
          >
            {t('changePassword.submit')}
          </StadiumButton>
        </form>
      </motion.div>
    </div>
  )
}
