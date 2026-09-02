import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, PartyPopper } from 'lucide-react'

import type { WheelSpinResult } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'

/**
 * What the wheel stopped on.
 *
 * The three cases are genuinely different and are worded as such: nothing was
 * won; something was given and here it is; something is OWED and a person will
 * be in touch. The last one must not read like the second — telling somebody
 * they have a thousand roubles when nobody has sent it yet is a promise the
 * screen cannot keep.
 */
export function WheelResultSheet({
  result,
  onClose,
}: {
  readonly result: WheelSpinResult | null
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  if (result === null || !result.spun) return null

  const prize = result.prize ?? {}
  const secret = prize.key ?? prize.promoCode ?? null

  const copy = async () => {
    if (secret === null) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm space-y-4 rounded-2xl bg-background p-5 text-center"
        onClick={(event) => event.stopPropagation()}
      >
        {result.kind === 'NOTHING' ? (
          <>
            <p className="text-lg font-semibold">{t('wheel.result.nothing')}</p>
            <p className="text-sm text-muted-foreground">{t('wheel.result.nothingHint')}</p>
          </>
        ) : result.status === 'PENDING' ? (
          <>
            <PartyPopper className="mx-auto h-8 w-8 text-amber-400" />
            <p className="text-lg font-semibold">{t('wheel.result.manual')}</p>
            {/* Owed, not given. The operator opens a conversation, and that is
                where the prize is actually arranged. */}
            <p className="text-sm text-muted-foreground">{t('wheel.result.manualHint')}</p>
          </>
        ) : (
          <>
            <PartyPopper className="mx-auto h-8 w-8 text-amber-400" />
            <p className="text-lg font-semibold">{t('wheel.result.won')}</p>
            <p className="text-base">{describePrize(result, t)}</p>
            {secret !== null ? (
              <button
                type="button"
                onClick={copy}
                className="mx-auto flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-sm"
              >
                {secret}
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            ) : null}
          </>
        )}
        <StadiumButton className="w-full" onClick={onClose}>
          {t('wheel.result.close')}
        </StadiumButton>
      </div>
    </div>
  )
}

/** One line saying what arrived. */
function describePrize(
  result: WheelSpinResult,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const prize = result.prize ?? {}
  if (typeof prize.points === 'number') return t('wheel.prize.points', { count: prize.points })
  if (typeof prize.spins === 'number') return t('wheel.prize.spins', { count: prize.spins })
  if (typeof prize.days === 'number') return t('wheel.prize.days', { count: prize.days })
  if (typeof prize.trafficGb === 'number') return t('wheel.prize.traffic', { count: prize.trafficGb })
  if (typeof prize.discountPercent === 'number') {
    return t('wheel.prize.discount', { percent: prize.discountPercent })
  }
  if (typeof prize.promoCode === 'string') return t('wheel.prize.promocode')
  if (typeof prize.key === 'string') return t('wheel.prize.key')
  return t('wheel.prizeFallback')
}
