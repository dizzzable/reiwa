import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Shield } from 'lucide-react'
import { getPlans } from '@/lib/api-client'
import type { Plan } from '@/types/api'
import { usePurchaseStore } from '@/stores/purchase.store'
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

  // The public catalog endpoint already returns ONLY active, non-archived,
  // context-available plans. Free trials are CLAIMED (not bought) via the
  // dashboard TrialCta, so they must not appear in the paid "Buy" catalog;
  // paid trials (`trialFree === false`) stay purchasable.
  const activePlans = plans.filter((p) => !(p.isTrial && p.trialFree))

  function handleSelect(plan: Plan) {
    selectPlan(plan)
    navigate('/purchase')
  }

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <BackButton fallback="/dashboard" label={t('common.back')} />
        <div>
          <h1 className="text-lg font-semibold">{t('plans.title')}</h1>
          <p className="text-xs text-zinc-500">{t('plans.subtitle')}</p>
        </div>
      </div>

      <div className="px-5 space-y-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[150px] animate-pulse rounded-card bg-zinc-800/50" />
          ))
        ) : activePlans.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-zinc-500">
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
