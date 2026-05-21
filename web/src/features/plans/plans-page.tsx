import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { ArrowLeft, Zap, Shield, Infinity } from 'lucide-react'
import { getPlans } from '@/lib/api-client'
import type { Plan } from '@/types/api'
import { usePurchaseStore } from '@/stores/purchase.store'
import { cn } from '@/lib/utils'

function getLowestPrice(plan: Plan): { amount: number; currency: string; days: number } | null {
  if (!plan.durations.length) return null
  const allPrices = plan.durations.flatMap(d => d.prices.map(p => ({ ...p, days: d.days })))
  if (!allPrices.length) return null
  const usd = allPrices.filter(p => p.currency === 'USD')
  const rub = allPrices.filter(p => p.currency === 'RUB')
  const list = usd.length ? usd : rub.length ? rub : allPrices
  const minDays = Math.min(...plan.durations.map(d => d.days))
  const minPrice = list.reduce((min, p) => p.price < min.price ? p : min, list[0])
  return { amount: minPrice.price, currency: minPrice.currency, days: minDays }
}

const TYPE_ICONS: Record<string, React.FC<{ className?: string }>> = {
  TRAFFIC: ({ className }) => <Zap className={className} />,
  DEVICES: ({ className }) => <Shield className={className} />,
  UNLIMITED: ({ className }) => <Infinity className={className} />,
  BOTH: ({ className }) => <Shield className={className} />,
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', RUB: '₽', USDT: '$', TON: 'TON',
}

export default function PlansPage() {
  const navigate = useNavigate()
  const { selectPlan } = usePurchaseStore()

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['plans'],
    queryFn: getPlans,
    staleTime: 300_000,
  })

  const activePlans = plans.filter(p => p.isActive && !p.isArchived)

  function handleSelect(plan: Plan) {
    selectPlan(plan)
    navigate('/purchase')
  }

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <button onClick={() => navigate(-1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 hover:text-white transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Тарифы</h1>
          <p className="text-xs text-zinc-500">Выберите подходящий план</p>
        </div>
      </div>

      <div className="px-5 space-y-3">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-zinc-800/50" />
          ))
        ) : activePlans.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-zinc-500">
            <Shield className="h-12 w-12 opacity-30" />
            <p>Нет доступных тарифов</p>
          </div>
        ) : (
          activePlans.map((plan, i) => {
            const price = getLowestPrice(plan)
            const Icon = TYPE_ICONS[plan.type] ?? Shield

            return (
              <motion.button
                key={plan.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                onClick={() => handleSelect(plan)}
                className={cn(
                  'w-full text-left glass-card p-4',
                  'hover:border-rose-500/30 hover:bg-rose-500/[0.04]',
                  'active:scale-[0.98] transition-all duration-150',
                  'flex items-center gap-4',
                )}
              >
                {/* Icon */}
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500">
                  <Icon className="h-6 w-6" />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white truncate">{plan.name}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {plan.trafficLimit ? `${plan.trafficLimit} GB` : 'Безлимит'}
                    {plan.deviceLimit ? ` · ${plan.deviceLimit} устройств` : ''}
                  </p>
                  <p className="text-xs text-zinc-600 mt-0.5">
                    {plan.durations.length} {plan.durations.length === 1 ? 'вариант' : 'варианта'} срока
                  </p>
                </div>

                {/* Price */}
                {price && (
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-bold text-rose-400">
                      от {CURRENCY_SYMBOLS[price.currency] ?? ''}{price.amount.toFixed(2)}
                    </p>
                    <p className="text-xs text-zinc-500">/{price.days} дн.</p>
                  </div>
                )}
              </motion.button>
            )
          })
        )}
      </div>
    </div>
  )
}
