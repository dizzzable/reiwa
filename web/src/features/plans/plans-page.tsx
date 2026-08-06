import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Shield, TriangleAlert } from 'lucide-react'
import { getActionPolicy, getPlans } from '@/lib/api-client'
import type { Plan } from '@/types/api'
import { usePurchaseStore } from '@/stores/purchase.store'
import {
  isSubscriptionLimitReached,
  notifySubscriptionLimitReached,
} from '@/lib/subscription-limit'
import { subscriptionQueryKeys } from '@/lib/subscription-query-keys'
import { BackButton } from '@/components/ui/back-button'
import { TariffCard } from './tariff-card'

export default function PlansPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { selectPlan } = usePurchaseStore()

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['plans'],
    queryFn: getPlans,
    staleTime: 300_000,
  })

  const { data: actionPolicy, isFetched: policyFetched } = useQuery({
    queryKey: subscriptionQueryKeys.actionPolicy(),
    queryFn: () => getActionPolicy(),
    staleTime: 30_000,
  })

  // The public catalog endpoint already returns ONLY active, non-archived,
  // context-available plans. Free trials are CLAIMED (not bought) via the
  // dashboard TrialCta, so they must not appear in the paid "Buy" catalog;
  // paid trials (`trialFree === false`) stay purchasable.
  const activePlans = plans.filter((p) => !(p.isTrial && p.trialFree))
  const limitReached = isSubscriptionLimitReached(actionPolicy)

  function handleSelect(plan: Plan) {
    if (limitReached) {
      // Toast only — the banner above the list is already saying this, and the
      // user is not going anywhere. The native dialog stays reserved for the
      // purchase screen, which answers by navigating away.
      notifySubscriptionLimitReached(t, actionPolicy, { nativeAlert: false })
      return
    }
    selectPlan(plan)
    navigate('/purchase')
  }

  const limitNotice =
    typeof actionPolicy?.activeSubscriptionCount === 'number' &&
    typeof actionPolicy?.maxSubscriptions === 'number'
      ? t('subscription.limitReachedDetail', {
          current: actionPolicy.activeSubscriptionCount,
          max: actionPolicy.maxSubscriptions,
        })
      : t('subscription.limitReached')

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <BackButton fallback="/dashboard" label={t('common.back')} />
        <div>
          <h1 className="text-lg font-semibold">{t('plans.title')}</h1>
          <p className="text-xs text-[color:var(--brand-muted-foreground)]">{t('plans.subtitle')}</p>
        </div>
      </div>

      <div className="px-5 space-y-4">
        {/*
          At capacity the catalogue stays visible and this sits above it, rather
          than replacing it. Being full is a reason not to be able to BUY, not a
          reason to be unable to LOOK — and the answer to "so what should I
          switch to when a slot frees up" is exactly the list this used to hide.

          It is also the only announcement on this screen. There used to be a
          toast on mount saying the same sentence, plus a native Telegram dialog
          behind it; one static line the user can re-read beats three transient
          copies of it, and the toast survives where it belongs — on a tap the
          app has to refuse.
        */}
        {policyFetched && limitReached ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/90" />
            <p className="text-xs leading-relaxed text-amber-100/90">{limitNotice}</p>
          </div>
        ) : null}

        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="theme-skeleton h-[150px] animate-pulse rounded-card" />
          ))
        ) : activePlans.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-[color:var(--brand-muted-foreground)]">
            <Shield className="h-12 w-12 opacity-30" />
            <p>{t('plans.emptyAvailable')}</p>
          </div>
        ) : (
          activePlans.map((plan, i) => (
            <TariffCard key={plan.id} plan={plan} index={i} onClick={() => handleSelect(plan)} />
          ))
        )}
      </div>
    </div>
  )
}
