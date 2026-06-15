import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { toast } from 'sonner'
import { NetworkBg } from '@/components/ui/network-bg'
import { ReiwaLogo } from '@/components/ui/reiwa-logo'
import { StadiumButton } from '@/components/ui/stadium-button'
import { hashPassword } from '@/lib/crypto'
import { changePasswordAuth } from '@/lib/api-client'
import { useBranding } from '@/lib/branding-provider'
import { useAuthStore } from '@/stores/auth.store'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'

export default function ChangePasswordPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { branding } = useBranding()

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

      // Refetch the session so the protected shell sees the cleared
      // requiresPasswordChange flag (otherwise StealthLayout bounces back here).
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })

      // Confirm success (the toast rides along to the dashboard) then redirect.
      toast.success(t('changePassword.success'))
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
        <div className="mb-8 flex flex-col items-center text-center">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', damping: 20, stiffness: 200 }}
            className="mb-5"
          >
            <div
              className="flex h-20 w-20 items-center justify-center rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur-xl"
              style={{ boxShadow: '0 0 60px var(--color-brand-glow)' }}
            >
              {branding.logoUrl ? (
                <img
                  src={branding.logoUrl}
                  alt={branding.brandName}
                  className="h-11 w-11 rounded-xl object-contain"
                />
              ) : (
                <ReiwaLogo className="h-11 w-11 text-(--brand-primary)" title={branding.brandName} />
              )}
            </div>
          </motion.div>
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
