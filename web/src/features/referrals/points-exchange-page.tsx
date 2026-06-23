import { useState } from 'react'
import type { ComponentType, SVGProps } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { ArrowLeft, Coins, Calendar, Zap, Tag, HardDrive, Loader2, Check, Copy } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getPointsExchangeOptions, exchangePoints } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'
import { TipCard } from '@/components/ui/tip-card'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

const TYPE_META: Record<string, { icon: ComponentType<SVGProps<SVGSVGElement>>; color: string }> = {
  SUBSCRIPTION_DAYS: { icon: Calendar, color: 'text-emerald-400' },
  GIFT_SUBSCRIPTION: { icon: Zap, color: 'text-violet-400' },
  DISCOUNT: { icon: Tag, color: 'text-amber-400' },
  TRAFFIC: { icon: HardDrive, color: 'text-blue-400' },
}

export default function PointsExchangePage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [points, setPoints] = useState('')
  const [giftCode, setGiftCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const typeLabel = (type: string) => t(`pointsExchange.types.${type}.label`, { defaultValue: type })
  const typeUnit = (type: string) => t(`pointsExchange.types.${type}.unit`, { defaultValue: '' })

  const { data: options, isLoading } = useQuery({
    queryKey: ['points-exchange-options'],
    queryFn: getPointsExchangeOptions,
  })

  const mutation = useMutation({
    mutationFn: () => exchangePoints(selectedType!, parseInt(points)),
    onSuccess: (result) => {
      if (result.success === false) {
        toast.error(t('pointsExchange.error'))
        return
      }
      queryClient.invalidateQueries({ queryKey: ['points-exchange-options'] })
      queryClient.invalidateQueries({ queryKey: ['session'] })
      if (result.code) {
        // GIFT_SUBSCRIPTION — show the minted promo code so the user can pass
        // it on. Without surfacing it the reward would be invisible.
        setGiftCode(result.code)
      } else {
        toast.success(t('pointsExchange.success'))
      }
      setSelectedType(null)
      setPoints('')
    },
    onError: () => toast.error(t('pointsExchange.error')),
  })

  async function copyGiftCode() {
    if (!giftCode) return
    try {
      await navigator.clipboard.writeText(giftCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-(--brand-primary)" />
      </div>
    )
  }

  if (giftCode) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center pb-20">
        <div className="flex h-20 w-20 items-center justify-center rounded-full border border-violet-500/30 bg-violet-500/10">
          <Zap className="h-10 w-10 text-violet-400" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-white">{t('pointsExchange.giftCodeTitle')}</h2>
          <p className="mt-1 text-sm text-zinc-400">{t('pointsExchange.giftCodeHint')}</p>
        </div>
        <button
          type="button"
          onClick={copyGiftCode}
          className="flex w-full max-w-xs items-center justify-between gap-3 rounded-2xl border border-white/10 bg-zinc-800/60 px-5 py-4 transition-colors hover:border-(--brand-primary)/50"
        >
          <span className="font-mono text-lg font-bold tracking-widest text-white">{giftCode}</span>
          {copied ? <Check className="h-5 w-5 text-emerald-400" /> : <Copy className="h-5 w-5 text-zinc-400" />}
        </button>
        <StadiumButton fullWidth size="lg" glow onClick={() => { setGiftCode(null); navigate('/referrals') }}>
          {t('pointsExchange.done')}
        </StadiumButton>
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
          <h1 className="text-lg font-semibold">{t('pointsExchange.title')}</h1>
        </div>
        <div className="px-5">
          <TipCard tone="info">{t('pointsExchange.unavailable')}</TipCard>
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
        <h1 className="text-lg font-semibold">{t('pointsExchange.title')}</h1>
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
            <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('pointsExchange.yourPoints')}</p>
            <p className="text-2xl font-bold text-white">{options.pointsBalance}</p>
          </div>
        </motion.div>
      </div>

      {!selectedType ? (
        /* Type selection */
        <div className="px-5 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">{t('pointsExchange.chooseType')}</p>
          {options.types.filter((t) => t.enabled).map((type) => {
            const meta = TYPE_META[type.type] ?? { icon: Coins, color: 'text-zinc-400' }
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
                  <p className="font-medium text-sm">{typeLabel(type.type)}</p>
                  <p className="text-xs text-zinc-500">{t('pointsExchange.rate', { cost: type.pointsCost, unit: typeUnit(type.type) })}</p>
                </div>
                {!type.available && <span className="text-[10px] text-zinc-600">{t('pointsExchange.unavailableShort')}</span>}
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
                const meta = TYPE_META[selectedType] ?? { icon: Coins, color: 'text-zinc-400' }
                const Icon: ComponentType<SVGProps<SVGSVGElement>> = meta.icon
                return (
                  <>
                    <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800', meta.color)}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <p className="font-medium">{typeLabel(selectedType)}</p>
                  </>
                )
              })()}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500">{t('pointsExchange.pointsAmount')}</label>
              <input
                type="number"
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                min={selectedOption?.minPoints ?? 1}
                max={selectedOption?.maxPoints === -1 ? options.pointsBalance : Math.min(selectedOption?.maxPoints ?? 999, options.pointsBalance)}
                className="w-full rounded-xl bg-zinc-800/80 px-4 py-3 text-lg font-bold text-white text-center outline-none focus:ring-1 focus:ring-(--brand-primary)/50"
              />
              <div className="flex justify-between text-[10px] text-zinc-600">
                <span>{t('pointsExchange.min', { value: selectedOption?.minPoints })}</span>
                <span>{t('pointsExchange.max', { value: selectedOption?.maxPoints === -1 ? options.pointsBalance : selectedOption?.maxPoints })}</span>
              </div>
            </div>

            {/* Preview */}
            <div className="rounded-xl bg-zinc-800/50 p-4 text-center">
              <p className="text-xs text-zinc-500 mb-1">{t('pointsExchange.youReceive')}</p>
              <p className="text-2xl font-bold text-(--brand-primary)">
                {computedValue} {selectedType ? typeUnit(selectedType) : ''}
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
            {mutation.isPending ? t('pointsExchange.exchanging') : t('pointsExchange.exchange')}
          </StadiumButton>
        </div>
      )}
    </div>
  )
}
