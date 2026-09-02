import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Coins, Gift, History, Loader2, Ticket } from 'lucide-react'

import {
  buySpins,
  getWheel,
  getWheelHistory,
  spinWheel,
  type WheelSector,
  type WheelSpinResult,
} from '@/lib/api-client'
import { createIdempotencyKey } from '@/lib/idempotency-key'
import { BackButton } from '@/components/ui/back-button'
import { StadiumButton } from '@/components/ui/stadium-button'
import { TipCard } from '@/components/ui/tip-card'
import { cn } from '@/lib/utils'

import { WheelDisc, rotationForIndex } from './components/wheel-disc'
import { WheelResultSheet } from './components/wheel-result-sheet'
import { WheelHistoryList } from './components/wheel-history-list'

/** How long the disc takes to come to rest, in step with the CSS transition. */
const SPIN_MS = 4200

export default function WheelPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [rotation, setRotation] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<WheelSpinResult | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  /**
   * One handle per INTENDED spin, minted when the button is pressed and kept
   * until the server answers. A handle per request would defeat the whole
   * mechanism: a retry would look like a second spin and cost one.
   */
  const spinKey = useRef<string | null>(null)
  const landing = useRef<number | null>(null)

  const wheel = useQuery({ queryKey: ['wheel'], queryFn: getWheel })
  const history = useQuery({
    queryKey: ['wheel', 'history'],
    queryFn: () => getWheelHistory({ limit: 30 }),
    enabled: historyOpen,
  })

  const sectors = useMemo(() => wheel.data?.sectors ?? [], [wheel.data])
  const label = useCallback(
    (sector: WheelSector) => sectorLabel(sector, t('wheel.prizeFallback')),
    [t],
  )

  const spin = useMutation({
    mutationFn: () => {
      spinKey.current ??= createIdempotencyKey('spin')
      return spinWheel(spinKey.current)
    },
    onSuccess: (data) => {
      if (!data.spun) {
        spinKey.current = null
        toast.error(t(`wheel.refusal.${data.reason ?? 'WHEEL_DISABLED'}`, t('wheel.refusal.WHEEL_DISABLED')))
        return
      }

      const index = sectors.findIndex((sector) => sector.id === data.sectorId)
      if (index < 0) {
        // The wheel changed under us — an operator edited a sector between the
        // view and the spin. Nothing is lost: the prize is already given, and
        // the result screen says what it was. Refetch instead of animating a
        // disc that no longer has that slice.
        finish(data)
        return
      }

      setSpinning(true)
      const next = rotationForIndex({ index, count: sectors.length, current: rotation })
      landing.current = next
      setRotation(next)
      window.setTimeout(() => finish(data), SPIN_MS)
    },
    onError: () => {
      spinKey.current = null
      setSpinning(false)
      toast.error(t('wheel.spinFailed'))
    },
  })

  const buy = useMutation({
    mutationFn: (count: number) => buySpins(count, createIdempotencyKey('buy')),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wheel'] })
      toast.success(t('wheel.bought'))
    },
    onError: () => toast.error(t('wheel.buyFailed')),
  })

  function finish(data: WheelSpinResult) {
    setSpinning(false)
    // The handle is retired only once the answer is in hand: until then a
    // retry must carry the same one.
    spinKey.current = null
    setResult(data)
    queryClient.invalidateQueries({ queryKey: ['wheel'] })
    queryClient.invalidateQueries({ queryKey: ['wheel', 'history'] })
  }

  if (wheel.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!wheel.data?.enabled) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-4">
        <BackButton fallback="/" />
        <TipCard>{t('wheel.disabled')}</TipCard>
      </div>
    )
  }

  const price = wheel.data.spinPricePoints
  const canBuy = price !== null && wheel.data.pointsBalance >= price

  return (
    <div className="mx-auto max-w-md space-y-5 p-4">
      <BackButton fallback="/" />

      <header className="text-center">
        <h1 className="text-2xl font-bold">{t('wheel.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('wheel.subtitle')}</p>
      </header>

      <div className="flex items-center justify-center gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5">
          <Ticket className="h-4 w-4" />
          {t('wheel.spins', { count: wheel.data.spinBalance })}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5">
          <Coins className="h-4 w-4" />
          {t('wheel.points', { count: wheel.data.pointsBalance })}
        </span>
      </div>

      <WheelDisc sectors={sectors} rotation={rotation} spinning={spinning} label={label} />

      <div className="space-y-2">
        <StadiumButton
          className="w-full"
          disabled={spinning || spin.isPending || !wheel.data.canSpin}
          onClick={() => spin.mutate()}
        >
          {spinning || spin.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Gift className="mr-2 h-4 w-4" />
          )}
          {wheel.data.freeSpin.available ? t('wheel.spinFree') : t('wheel.spin')}
        </StadiumButton>

        {!wheel.data.canSpin ? (
          <p className="text-center text-xs text-muted-foreground">
            {wheel.data.freeSpin.availableAt
              ? t('wheel.freeSpinAt', {
                  time: new Date(wheel.data.freeSpin.availableAt).toLocaleString(),
                })
              : t('wheel.noSpins')}
          </p>
        ) : null}

        {price !== null ? (
          <button
            type="button"
            disabled={!canBuy || buy.isPending}
            onClick={() => buy.mutate(1)}
            className={cn(
              'w-full rounded-full border px-4 py-2 text-sm transition-colors',
              canBuy ? 'hover:bg-accent' : 'opacity-50',
            )}
          >
            {t('wheel.buyOne', { price })}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="mx-auto flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          <History className="h-4 w-4" />
          {t('wheel.historyLink')}
        </button>
      </div>

      <WheelResultSheet result={result} onClose={() => setResult(null)} />
      <WheelHistoryList
        open={historyOpen}
        items={history.data?.items ?? []}
        loading={history.isLoading}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  )
}

/** The sector's own name, RU first, falling back to something readable. */
export function sectorLabel(
  sector: { readonly title: { ru?: string; en?: string } },
  fallback: string,
): string {
  const ru = sector.title?.ru
  const en = sector.title?.en
  if (ru && ru.trim() !== '') return ru
  if (en && en.trim() !== '') return en
  return fallback
}
