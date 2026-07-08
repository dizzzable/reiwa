import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Tag, CheckCircle2, ChevronRight, BadgePercent } from 'lucide-react'
import { activatePromocode, getAllSubscriptions } from '@/lib/api-client'
import type { PromoActivationResult } from '@/lib/api-client'
import { SESSION_QUERY_KEY, useSession } from '@/hooks/use-session'
import { promoSuccessKey, promoErrorKey } from './promo-result'
import { PromoHistory } from './promo-history'
import { StadiumButton } from '@/components/ui/stadium-button'
import { BackButton } from '@/components/ui/back-button'
import { TipCard } from '@/components/ui/tip-card'
import { toast } from 'sonner'

export default function PromoPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const [code, setCode] = useState('')
  const [success, setSuccess] = useState(false)
  const [resultMsg, setResultMsg] = useState('')
  // Pending step state — drives the subscription chooser / create-new confirm.
  const [selectIds, setSelectIds] = useState<readonly string[] | null>(null)
  const [confirmCreateNew, setConfirmCreateNew] = useState(false)

  // Subscriptions are only needed to label the chooser; fetch lazily once a
  // SELECT_SUBSCRIPTION step appears.
  const { data: subsData } = useQuery({
    queryKey: ['subscriptions', 'all'],
    queryFn: getAllSubscriptions,
    enabled: selectIds !== null,
  })
  const subscriptions = subsData?.subscriptions ?? []

  // Deep-link prefill: a promo-tagged broadcast button opens this page at
  // `/promo?code=<code>`. Read it once on mount, prefill the input, then strip
  // the param via history.replaceState so a refresh / back doesn't leave the
  // code lingering in the address bar (and the user can still edit it).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const prefill = params.get('code')?.trim()
    if (!prefill) return
    setCode(prefill.toUpperCase())
    params.delete('code')
    const query = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    )
  }, [])

  function handleResult(data: PromoActivationResult): void {
    switch (data.step) {
      case 'ACTIVATED': {
        const key = promoSuccessKey(data.reward)
        setSelectIds(null)
        setConfirmCreateNew(false)
        setSuccess(true)
        setResultMsg(t(key))
        // Refresh session (discount glow on the dashboard promo icon) and
        // EVERY subscription view so a granted reward (e.g. +days extending
        // expiry) shows at once. The app uses two distinct all-subscriptions
        // keys (`['subscriptions','all']` on the dashboard, `['subscriptions-all']`
        // on renewal/upgrade/addons) plus `['subscription']` on the detail
        // page and `['devices']` — invalidate them all so remaining days
        // update in the web cabinet just like they do in Telegram.
        void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
        void queryClient.invalidateQueries({ queryKey: ['subscriptions', 'all'] })
        void queryClient.invalidateQueries({ queryKey: ['subscriptions-all'] })
        void queryClient.invalidateQueries({ queryKey: ['subscription'] })
        void queryClient.invalidateQueries({ queryKey: ['devices'] })
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
        break
      }
      case 'SELECT_SUBSCRIPTION':
        setConfirmCreateNew(false)
        setSelectIds(data.availableSubscriptionIds)
        break
      case 'CREATE_NEW':
        setSelectIds(null)
        setConfirmCreateNew(true)
        break
      case 'REJECTED':
      default: {
        const ec = data.errorCode ?? ''
        toast.error(t(promoErrorKey(ec)))
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error')
        break
      }
    }
  }

  const mutation = useMutation({
    mutationFn: (opts?: { subscriptionId?: string; confirmCreateNew?: boolean }) =>
      activatePromocode(code.trim().toUpperCase(), opts),
    onSuccess: handleResult,
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : t('promo.activationError')
      toast.error(msg)
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error')
    },
  })

  if (success) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-8 px-8 text-center pb-20">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex h-24 w-24 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10"
          style={{ boxShadow: '0 0 40px rgba(16,185,129,0.3)' }}
        >
          <CheckCircle2 className="h-12 w-12 text-emerald-400" />
        </motion.div>
        <div>
          <h2 className="text-xl font-semibold text-emerald-400">{t('promo.done')}</h2>
          <p className="mt-2 text-sm text-zinc-400">{resultMsg}</p>
        </div>
        <StadiumButton onClick={() => navigate('/dashboard', { replace: true })} glow>
          {t('promo.toHome')}
        </StadiumButton>
      </div>
    )
  }

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <BackButton fallback="/dashboard" label={t('common.back')} />
        <h1 className="text-lg font-semibold">{t('promo.title')}</h1>
      </div>

      <div className="px-5 space-y-5">
        <TipCard tone="info" icon={<Tag className="h-4 w-4" />}>
          {t('promo.tip')}
        </TipCard>

        {/* Active-discount banner. Surfaces a discount that is currently
            applied to the account — whether it came from a promocode OR was
            granted directly by an operator on the profile (which leaves no
            promocode-activation row, so the history alone couldn't explain
            why the discount icon glows). Complements the code-labelled rows
            in PromoHistory below. */}
        <ActiveDiscountBanner
          personal={session?.personalDiscount ?? 0}
          purchase={session?.purchaseDiscount ?? 0}
        />

        {/* Step: choose which subscription the reward applies to. */}
        {selectIds !== null ? (
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-white">{t('promo.selectSubscription.title')}</h2>
              <p className="text-xs text-zinc-400">{t('promo.selectSubscription.description')}</p>
            </div>
            <div className="space-y-2">
              {selectIds.map((id) => {
                const sub = subscriptions.find((s) => s.id === id)
                const label =
                  sub?.plan?.name ?? sub?.profileName ?? `${t('promo.subscriptionLabel')} ${id.slice(-6)}`
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate({ subscriptionId: id })}
                    className="flex w-full items-center justify-between rounded-2xl border border-white/8 bg-zinc-800/50 px-5 py-4 text-left transition-colors hover:border-(--brand-primary)/50 disabled:opacity-50"
                  >
                    <span className="text-sm font-medium text-white">{label}</span>
                    <ChevronRight className="h-4 w-4 text-zinc-500" />
                  </button>
                )
              })}
            </div>
          </div>
        ) : confirmCreateNew ? (
          /* Step: confirm creating a brand-new subscription from the promo. */
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-white">{t('promo.createNew.title')}</h2>
              <p className="text-xs text-zinc-400">{t('promo.createNew.description')}</p>
            </div>
            <div className="flex gap-3">
              <StadiumButton
                fullWidth
                onClick={() => mutation.mutate({ confirmCreateNew: true })}
                disabled={mutation.isPending}
                loading={mutation.isPending}
                glow
              >
                {t('promo.createNew.confirm')}
              </StadiumButton>
              <StadiumButton
                fullWidth
                variant="ghost"
                onClick={() => {
                  setConfirmCreateNew(false)
                }}
                disabled={mutation.isPending}
              >
                {t('promo.createNew.cancel')}
              </StadiumButton>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder={t('promo.inputPlaceholder')}
                maxLength={32}
                className="w-full rounded-2xl border border-white/8 bg-zinc-800/50 px-5 py-4 text-center text-lg font-mono font-bold uppercase tracking-[0.3em] text-white placeholder:text-zinc-600 focus:border-(--brand-primary)/50 focus:outline-none transition-colors"
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) mutation.mutate(undefined) }}
              />

              <StadiumButton
                fullWidth size="lg"
                onClick={() => mutation.mutate(undefined)}
                disabled={!code.trim() || mutation.isPending}
                loading={mutation.isPending}
                glow={!!code.trim()}
              >
                {t('promo.activate')}
              </StadiumButton>
            </div>

            <PromoHistory />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * ActiveDiscountBanner
 * ────────────────────
 * A compact, liquid-glass banner naming the discount(s) currently applied to
 * the account. Violet accents the permanent personal discount, amber the
 * one-time next-purchase discount — matching the dashboard promo-icon glow.
 * Renders nothing when no discount is active.
 */
function ActiveDiscountBanner({ personal, purchase }: { personal: number; purchase: number }) {
  const { t } = useTranslation()
  if (personal <= 0 && purchase <= 0) return null
  return (
    <div className="space-y-2">
      {personal > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-violet-500/30 bg-violet-500/10 px-4 py-3 backdrop-blur-xl">
          <BadgePercent className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-violet-100">
              {t('promo.activeDiscount.personal', { percent: personal })}
            </p>
            <p className="mt-0.5 text-xs text-violet-300/70">{t('promo.activeDiscount.hint')}</p>
          </div>
        </div>
      )}
      {purchase > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 backdrop-blur-xl">
          <BadgePercent className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-100">
              {t('promo.activeDiscount.purchase', { percent: purchase })}
            </p>
            <p className="mt-0.5 text-xs text-amber-300/70">{t('promo.activeDiscount.hint')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
