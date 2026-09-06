import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { toast } from 'sonner'
import { NetworkBg } from '@/components/ui/network-bg'
import { EntryBrandTile } from '@/components/ui/entry-brand-tile'
import { StadiumButton } from '@/components/ui/stadium-button'
import { hashPassword } from '@/lib/crypto'
import { changePasswordAuth } from '@/lib/api-client'
import { readNextDestination } from '@/lib/next-destination'
import { useAuthStore } from '@/stores/auth.store'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'

export default function ChangePasswordPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

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

      // Confirm success (the toast rides along) then redirect — to the page the
      // user was aiming at when this gate stopped them (StealthLayout forwards
      // it as `?next=`), else the dashboard.
      toast.success(t('changePassword.success'))
      navigate(readNextDestination() ?? '/dashboard', { replace: true })
    } catch (err: unknown) {
      // Branch on the CODE, never on the sentence. The sentence is English
      // and this cabinet falls back to Russian, so printing it verbatim put
      // English in front of the Russian-speaking majority — on a refusal they
      // have to act on.
      const response = (err as {
        response?: { status?: number; data?: { code?: string; message?: string } }
      })?.response
      const code = response?.data?.code
      if (code === 'CURRENT_PASSWORD_INCORRECT') {
        setError(t('changePassword.errorCurrentWrong'))
      } else if (response?.status === 400) {
        // The password policy. Branching only on the code above collapsed this
        // into a generic failure, and the customer lost the reason their new
        // password was refused on the one screen they have to finish.
        setError(t('changePassword.errorPolicy'))
      } else if (response?.status === 503) {
        // Carries a retry-after instruction. Same loss, and this one tells the
        // customer to do something.
        setError(t('changePassword.errorRetryLater'))
      } else {
        setError(t('changePassword.errorGeneric'))
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    // Own scroll container: html/body/#root are `100dvh; overflow:hidden`, and
    // the iOS keyboard shrinks only the visual viewport — without an inner
    // scroller WebKit jerks the layout viewport to reveal the focused input.
    <div className="scroll-area entry-scroller relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-4">
      <NetworkBg intensity="medium" />

      {/* Opacity-only entrance: the tile and glass inputs inside carry
          backdrop-filter, and a y-slide re-blurs their backdrop every frame. */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8"
      >
        {/* Header */}
        <div className="mb-8 flex flex-col items-center text-center">
          <EntryBrandTile className="mb-5" />
          <h1 className="text-xl font-bold text-[color:var(--brand-foreground)]">
            {t('changePassword.title')}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--brand-muted-foreground)]">
            {t('changePassword.description')}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current password */}
          <div>
            <label
              htmlFor="current-password"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[color:var(--brand-muted-foreground)]"
            >
              {t('changePassword.currentPassword')}
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="glass-input w-full rounded-xl px-4 py-3 text-sm"
              placeholder={t('changePassword.currentPasswordPlaceholder')}
              disabled={isSubmitting}
            />
          </div>

          {/* New password */}
          <div>
            <label
              htmlFor="new-password"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[color:var(--brand-muted-foreground)]"
            >
              {t('changePassword.newPassword')}
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="glass-input w-full rounded-xl px-4 py-3 text-sm"
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
