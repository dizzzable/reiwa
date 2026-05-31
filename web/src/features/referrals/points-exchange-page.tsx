import { useState } from 'react'
import type { ComponentType, SVGProps } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ArrowLeft, Coins, Calendar, Zap, Tag, HardDrive, Loader2, Check } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getPointsExchangeOptions, exchangePoints } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'
import { TipCard } from '@/components/ui/tip-card'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

const TYPE_META: Record<string, { icon: ComponentType<SVGProps<SVGSVGElement>>; label: string; unit: string; color: string }> = {
  SUBSCRIPTION_DAYS: { icon: Calendar, label: 'Дни подписки', unit: 'дней', color: 'text-emerald-400' },
  GIFT_SUBSCRIPTION: { icon: Zap, label: 'Подарочная подписка', unit: 'промокод', color: 'text-violet-400' },
  DISCOUNT: { icon: Tag, label: 'Скидка', unit: '%', color: 'text-amber-400' },
  TRAFFIC: { icon: HardDrive, label: 'Трафик', unit: 'GB', color: 'text-blue-400' },
}

export default function PointsExchangePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [points, setPoints] = useState('')

  const { data: options, isLoading } = useQuery({
    queryKey: ['points-exchange-options'],
    queryFn: getPointsExchangeOptions,
  })

  const mutation = useMutation({
    mutationFn: () => exchangePoints(selectedType!, parseInt(points)),
    onSuccess: (result: any) => {
      toast.success('Баллы обменяны!')
      queryClient.invalidateQueries({ queryKey: ['points-exchange-options'] })
      queryClient.invalidateQueries({ queryKey: ['session'] })
      setSelectedType(null)
      setPoints('')
    },
    onError: () => toast.error('Не удалось обменять баллы'),
  })

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-(--brand-primary)" />
      </div>
    )
  }

  if (!options?.exchangeEnabled) {
    return (
      <div className="pb-8">
        <div className="flex items-center gap-3 px-5 py-5">
          <button onClick={() => navigate(-1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold">Обмен баллов</h1>
        </div>
        <div className="px-5">
          <TipCard tone="info">Обмен баллов временно недоступен.</TipCard>
        </div>
      </div>
    )
  }

  const selectedOption = options.types.find((t) => t.type === selectedType)
  const numPoints = parseInt(points) || 0
  const computedValue = selectedOption ? Math.floor(numPoints / selectedOption.pointsCost) : 0

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <button onClick={() => selectedType ? setSelectedType(null) : navigate(-1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">Обмен баллов</h1>
      </div>

      {/* Balance */}
      <div className="px-5 mb-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card p-5 flex items-center gap-4"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/20">
            <Coins className="h-6 w-6 text-amber-400" />
          </div>
          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wide">Ваши баллы</p>
            <p className="text-2xl font-bold text-white">{options.pointsBalance}</p>
          </div>
        </motion.div>
      </div>

      {!selectedType ? (
        /* Type selection */
        <div className="px-5 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Выберите тип обмена</p>
          {options.types.filter((t) => t.enabled).map((type) => {
            const meta = TYPE_META[type.type] ?? { icon: Coins, label: type.type, unit: '', color: 'text-zinc-400' }
            const Icon: ComponentType<SVGProps<SVGSVGElement>> = meta.icon
            return (
              <button
                key={type.type}
                onClick={() => { setSelectedType(type.type); setPoints(String(type.minPoints)) }}
                disabled={!type.available}
                className={cn(
                  'w-full glass-card p-4 flex items-center gap-4 active:scale-[0.98] transition-all',
                  !type.available && 'opacity-50'
                )}
              >
                <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800', meta.color)}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1 text-left">
                  <p className="font-medium text-sm">{meta.label}</p>
                  <p className="text-xs text-zinc-500">{type.pointsCost} баллов = 1 {meta.unit}</p>
                </div>
                {!type.available && <span className="text-[10px] text-zinc-600">Недоступно</span>}
              </button>
            )
          })}
        </div>
      ) : (
        /* Exchange form */
        <div className="px-5 space-y-4">
          <div className="glass-card p-5 space-y-4">
            <div className="flex items-center gap-3">
              {(() => {
                const meta = TYPE_META[selectedType] ?? { icon: Coins, label: selectedType, color: 'text-zinc-400' }
                const Icon: ComponentType<SVGProps<SVGSVGElement>> = meta.icon
                return (
                  <>
                    <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800', meta.color)}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <p className="font-medium">{meta.label}</p>
                  </>
                )
              })()}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500">Количество баллов</label>
              <input
                type="number"
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                min={selectedOption?.minPoints ?? 1}
                max={selectedOption?.maxPoints === -1 ? options.pointsBalance : Math.min(selectedOption?.maxPoints ?? 999, options.pointsBalance)}
                className="w-full rounded-xl bg-zinc-800/80 px-4 py-3 text-lg font-bold text-white text-center outline-none focus:ring-1 focus:ring-(--brand-primary)/50"
              />
              <div className="flex justify-between text-[10px] text-zinc-600">
                <span>Мин: {selectedOption?.minPoints}</span>
                <span>Макс: {selectedOption?.maxPoints === -1 ? options.pointsBalance : selectedOption?.maxPoints}</span>
              </div>
            </div>

            {/* Preview */}
            <div className="rounded-xl bg-zinc-800/50 p-4 text-center">
              <p className="text-xs text-zinc-500 mb-1">Вы получите</p>
              <p className="text-2xl font-bold text-(--brand-primary)">
                {computedValue} {TYPE_META[selectedType]?.unit ?? ''}
              </p>
            </div>
          </div>

          <StadiumButton
            fullWidth
            size="lg"
            glow
            onClick={() => mutation.mutate()}
            disabled={numPoints < (selectedOption?.minPoints ?? 1) || numPoints > options.pointsBalance || mutation.isPending}
            icon={mutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
          >
            {mutation.isPending ? 'Обмен...' : 'Обменять'}
          </StadiumButton>
        </div>
      )}
    </div>
  )
}
