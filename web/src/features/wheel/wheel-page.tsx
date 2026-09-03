import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Coins, History, Loader2, Sparkles, Ticket } from 'lucide-react'

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

import { WheelDisc, type WheelDiscHandle } from './components/wheel-disc'
import { WheelResultSheet } from './components/wheel-result-sheet'
import { WheelHistoryList } from './components/wheel-history-list'

/** Telegram's own feedback, when the cabinet is running inside Telegram. */
function haptic(): NonNullable<NonNullable<Window['Telegram']>['WebApp']>['HapticFeedback'] {
  return window.Telegram?.WebApp?.HapticFeedback
}

export default function WheelPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<WheelSpinResult | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const disc = useRef<WheelDiscHandle | null>(null)
  /**
   * One handle per INTENDED spin, minted when the button is pressed and kept
   * until the server answers. A handle per request would defeat the whole
   * mechanism: a retry would look like a second spin and cost one.
   */
  const spinKey = useRef<string | null>(null)
  /**
   * The answer, held while the disc is still turning. The prize is already
   * granted at this point — the wheel is catching up with a decision that
   * has been taken — so this must survive anything the animation does.
   */
  const pending = useRef<WheelSpinResult | null>(null)
  /** The same contract for buying: one handle per intended purchase. */
  const buyKey = useRef<string | null>(null)

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

  /** Everything that has to happen once the answer is on screen. */
  const reveal = useCallback(
    (data: WheelSpinResult) => {
      setSpinning(false)
      pending.current = null
      // The handle is retired only once the answer is in hand: until then a
      // retry must carry the same one.
      spinKey.current = null
      setResult(data)
      haptic()?.notificationOccurred?.(data.kind === 'NOTHING' ? 'warning' : 'success')
      queryClient.invalidateQueries({ queryKey: ['wheel'] })
      queryClient.invalidateQueries({ queryKey: ['wheel', 'history'] })
    },
    [queryClient],
  )

  /** The disc has come to rest — show what it landed on. */
  const onSettled = useCallback(() => {
    const data = pending.current
    if (data === null) return
    reveal(data)
  }, [reveal])

  /**
   * A tooth passed under the pointer. Only the last second is felt: forty
   * taps over four seconds is not anticipation, it is a rattle.
   */
  const onTick = useCallback((remainingMs: number) => {
    if (remainingMs < 1200) haptic()?.impactOccurred?.('light')
  }, [])

  const spin = useMutation({
    mutationFn: () => {
      spinKey.current ??= createIdempotencyKey('spin')
      return spinWheel(spinKey.current)
    },
    onMutate: () => {
      haptic()?.impactOccurred?.('medium')
    },
    onSuccess: (data) => {
      if (!data.spun) {
        // A refusal is a definitive answer and costs nothing, so the next
        // press is a new intent and gets a new handle.
        spinKey.current = null
        setSpinning(false)
        toast.error(
          t(`wheel.refusal.${data.reason ?? 'WHEEL_DISABLED'}`, t('wheel.refusal.WHEEL_DISABLED')),
        )
        return
      }

      const index = sectors.findIndex((sector) => sector.id === data.sectorId)
      if (index < 0) {
        // The wheel changed under us — an operator edited a sector between
        // the view and the spin. Nothing is lost: the prize is already
        // given and the result screen says what it was. Show it rather than
        // animate a disc that no longer has that slice.
        reveal(data)
        return
      }

      pending.current = data
      setSpinning(true)
      disc.current?.spinTo(index)
    },
    onError: () => {
      // The handle is KEPT. An error means no answer arrived — not that
      // nothing happened. The spin may well have been taken and the prize
      // settled with the response lost on the way back, and minting a fresh
      // handle for the next press would spend a second spin to find out.
      // Sent again, the same handle replays the spin that already happened.
      pending.current = null
      setSpinning(false)
      toast.error(t('wheel.spinFailed'))
    },
  })

  const buy = useMutation({
    mutationFn: (count: number) => {
      buyKey.current ??= createIdempotencyKey('buy')
      return buySpins(count, buyKey.current)
    },
    onSuccess: () => {
      buyKey.current = null
      queryClient.invalidateQueries({ queryKey: ['wheel'] })
      haptic()?.notificationOccurred?.('success')
      toast.success(t('wheel.bought'))
    },
    // Kept on error for the same reason the spin handle is: a lost response
    // to a purchase that went through must not be paid for twice.
    onError: () => toast.error(t('wheel.buyFailed')),
  })

  /** The slice the result belongs to, for its colour on the result screen. */
  const landed = useMemo(
    () => sectors.find((sector) => sector.id === result?.sectorId) ?? null,
    [sectors, result?.sectorId],
  )

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
        <BackButton fallback="/events" />
        <TipCard>{t('wheel.disabled')}</TipCard>
      </div>
    )
  }

  const price = wheel.data.spinPricePoints
  const canBuy = price !== null && wheel.data.pointsBalance >= price
  const busy = spinning || spin.isPending

  return (
    <div className="mx-auto max-w-md space-y-5 p-4">
      <BackButton fallback="/events" />

      <header className="text-center">
        <h1 className="text-2xl font-bold">{t('wheel.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('wheel.subtitle')}</p>
      </header>

      <div className="flex items-center justify-center gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] px-3 py-1.5">
          <Ticket className="h-4 w-4" />
          {t('wheel.spins', { count: wheel.data.spinBalance })}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] px-3 py-1.5">
          <Coins className="h-4 w-4" />
          {t('wheel.points', { count: wheel.data.pointsBalance })}
        </span>
      </div>

      <WheelDisc ref={disc} sectors={sectors} label={label} onSettled={onSettled} onTick={onTick} />

      <div className="space-y-2">
        <StadiumButton
          size="lg"
          className="w-full"
          glow={wheel.data.canSpin && !busy}
          loading={busy}
          icon={<Sparkles className="h-5 w-5" />}
          disabled={busy || !wheel.data.canSpin}
          onClick={() => spin.mutate()}
        >
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
            disabled={!canBuy || buy.isPending || busy}
            onClick={() => buy.mutate(1)}
            className={cn(
              'w-full rounded-full border border-[color:var(--color-border-soft)] px-4 py-2 text-sm transition-colors',
              canBuy && !busy ? 'hover:bg-[color:var(--color-surface)]' : 'opacity-50',
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

      <WheelResultSheet result={result} sector={landed} onClose={() => setResult(null)} />
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
