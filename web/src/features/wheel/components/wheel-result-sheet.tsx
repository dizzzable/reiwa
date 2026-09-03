import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Copy } from 'lucide-react'

import type { WheelSector, WheelSpinResult } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'

import { iconFor, lookOf } from '../prize-look'
import { PrizeBurst } from './prize-burst'

/**
 * What the wheel stopped on.
 *
 * The three cases are genuinely different and are worded — and staged — as
 * three. Nothing was won: quiet, no confetti, an invitation to come back.
 * Something was given: the prize, its light, and the code to copy if there
 * is one. Something is OWED: the same warmth, but it must not read like the
 * second — telling somebody they have a thousand roubles when nobody has
 * sent it yet is a promise this screen cannot keep.
 */
export function WheelResultSheet({
  result,
  sector,
  onClose,
}: {
  readonly result: WheelSpinResult | null
  /** The slice it landed on, for its colour and glyph. Absent if the
      operator edited the wheel between the view and the spin. */
  readonly sector: WheelSector | null
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion()
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | null>(null)

  const open = result !== null && result.spun

  // Escape closes it, like every other sheet in the cabinet.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // A fresh result deserves a fresh button: the tick from the last prize
  // must not be sitting there next to a code nobody has copied yet.
  useEffect(() => {
    setCopied(false)
  }, [result?.spinId])

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    },
    [],
  )

  const prize = result?.prize ?? {}
  const secret = prize.key ?? prize.promoCode ?? null
  const kind = result?.kind ?? 'NOTHING'
  const look = lookOf(sector?.rarity)
  const Glyph = iconFor({ kind, iconKind: sector?.iconKind, iconRef: sector?.iconRef })
  const empty = kind === 'NOTHING'
  const owed = result?.status === 'PENDING'

  const copy = async () => {
    if (secret === null) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <AnimatePresence>
      {open && result !== null ? (
        <motion.div
          key="wheel-result"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 p-4 backdrop-blur-sm sm:items-center"
          role="dialog"
          aria-modal="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.div
            className="relative w-full max-w-sm overflow-hidden rounded-[var(--radius-card)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)] p-6 text-center backdrop-blur-2xl"
            style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom, 0px))' }}
            initial={
              reduceMotion === true ? { opacity: 0 } : { opacity: 0, y: 40, scale: 0.94 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion === true ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.97 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            onClick={(event) => event.stopPropagation()}
          >
            {empty ? null : (
              <PrizeBurst
                rarity={sector?.rarity ?? 'COMMON'}
                spinId={result.spinId ?? 'spin'}
                muted={owed}
              />
            )}

            <div className="relative">
              {/* The glyph sits in a ring of its own colour — the same
                  colour the slice had, so the prize and the slice it came
                  from are recognisably one thing. */}
              <motion.div
                className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border"
                style={{
                  borderColor: empty ? 'var(--color-border-strong)' : look.glow,
                  backgroundColor: empty ? 'var(--color-surface)' : `${look.glow}1f`,
                  color: empty ? 'var(--brand-muted-foreground)' : look.glow,
                  boxShadow: empty ? 'none' : `0 0 32px ${look.glow}40`,
                }}
                initial={reduceMotion === true ? false : { scale: 0.4, rotate: -25 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', damping: 12, stiffness: 260, delay: 0.05 }}
              >
                <Glyph className="h-8 w-8" strokeWidth={1.75} />
              </motion.div>

              <h2 className="mt-4 text-xl font-bold">
                {empty
                  ? t('wheel.result.nothing')
                  : owed
                    ? t('wheel.result.manual')
                    : t('wheel.result.won')}
              </h2>

              <p className="mt-1 text-sm text-[color:var(--brand-muted-foreground)]">
                {empty
                  ? t('wheel.result.nothingHint')
                  : owed
                    ? t('wheel.result.manualHint')
                    : describePrize(result, t)}
              </p>

              {secret !== null ? (
                <button
                  type="button"
                  onClick={copy}
                  className="mx-auto mt-4 flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] border border-[color:var(--color-border-strong)] bg-[color:var(--color-surface)] px-3 py-3 font-mono text-sm break-all"
                >
                  <span className="min-w-0 break-all">{secret}</span>
                  {copied ? (
                    <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                  ) : (
                    <Copy className="h-4 w-4 shrink-0 opacity-70" />
                  )}
                </button>
              ) : null}

              {secret !== null ? (
                <p className="mt-2 text-xs text-[color:var(--brand-muted-foreground)]">
                  {t('wheel.result.keptInHistory')}
                </p>
              ) : null}

              <StadiumButton className="mt-5 w-full" onClick={onClose}>
                {t('wheel.result.close')}
              </StadiumButton>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
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
