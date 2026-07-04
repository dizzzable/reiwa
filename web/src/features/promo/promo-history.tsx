/**
 * PromoHistory
 * ────────────
 * The activation-history block shown at the bottom of the promo page. Lists a
 * user's activated promocodes newest-first and highlights each row by state:
 *   • Активна  — a discount coupon whose discount is currently applied to the
 *     account (drives the violet/amber promo-icon glow on the dashboard).
 *   • Истёк    — the coupon's operator-picked expiry date has passed (or the
 *     promocode was disabled).
 *   • Применён — a one-time reward (days/traffic/devices/subscription) that was
 *     granted and consumed.
 *
 * Colors mirror the rest of the cabinet: discount types reuse the dashboard
 * glow palette (violet = personal, amber = purchase), the remaining reward
 * types reuse the referrals/points reward palette.
 */
import { useMemo, type ComponentType } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Calendar, HardDrive, Smartphone, Gift, BadgePercent, Percent, Tag } from 'lucide-react'
import { getPromoActivations } from '@/lib/api-client'
import type { PromoActivation } from '@/types/api'
import { useSession } from '@/hooks/use-session'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/utils'

type RowState = 'active' | 'expired' | 'applied'

interface RewardMeta {
  readonly icon: ComponentType<{ className?: string }>
  /** Tile background + icon color classes. */
  readonly tile: string
  /** Accent color classes for the "active" badge. */
  readonly activeBadge: string
}

const REWARD_META: Record<string, RewardMeta> = {
  DURATION: { icon: Calendar, tile: 'bg-emerald-500/10 text-emerald-400', activeBadge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  TRAFFIC: { icon: HardDrive, tile: 'bg-blue-500/10 text-blue-400', activeBadge: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  DEVICES: { icon: Smartphone, tile: 'bg-cyan-500/10 text-cyan-400', activeBadge: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  SUBSCRIPTION: { icon: Gift, tile: 'bg-violet-500/10 text-violet-400', activeBadge: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  PERSONAL_DISCOUNT: { icon: BadgePercent, tile: 'bg-violet-500/10 text-violet-400', activeBadge: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  PURCHASE_DISCOUNT: { icon: Percent, tile: 'bg-amber-500/10 text-amber-400', activeBadge: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
}

const FALLBACK_META: RewardMeta = {
  icon: Tag,
  tile: 'bg-zinc-500/10 text-zinc-400',
  activeBadge: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
}

function rewardMeta(type: string): RewardMeta {
  return REWARD_META[type] ?? FALLBACK_META
}

/** Formats the reward magnitude with its unit, by reward type. */
function formatRewardValue(a: PromoActivation, t: (k: string) => string): string {
  const v = a.rewardValue ?? 0
  switch (a.rewardType) {
    case 'DURATION':
      return v > 0 ? `+${v} ${t('promo.historyMeta.units.days')}` : ''
    case 'TRAFFIC':
      return v > 0 ? `+${v} ${t('promo.historyMeta.units.gb')}` : ''
    case 'DEVICES':
      return v > 0 ? `+${v} ${t('promo.historyMeta.units.devices')}` : ''
    case 'PERSONAL_DISCOUNT':
    case 'PURCHASE_DISCOUNT':
      return v > 0 ? `−${v}%` : ''
    default:
      return ''
  }
}

export function PromoHistory() {
  const { t } = useTranslation()
  const { session } = useSession()

  const { data, isLoading } = useQuery({
    queryKey: ['promo', 'activations'],
    queryFn: () => getPromoActivations(1, 30),
    staleTime: 30_000,
  })

  const activations = useMemo<PromoActivation[]>(() => data?.activations ?? [], [data])

  // Which discount activation is the one currently applied to the account.
  // Discounts are single-valued on the User row (the latest activation wins),
  // so the *most recent* row of a discount type is the active one when the
  // session still carries that discount. The list is newest-first, so the
  // first matching row is the most recent.
  const activeId = useMemo(() => {
    const personalOn = (session?.personalDiscount ?? 0) > 0
    const purchaseOn = (session?.purchaseDiscount ?? 0) > 0
    const ids = new Set<string>()
    if (personalOn) {
      const row = activations.find((a) => a.rewardType === 'PERSONAL_DISCOUNT')
      if (row) ids.add(row.id)
    }
    if (purchaseOn) {
      const row = activations.find((a) => a.rewardType === 'PURCHASE_DISCOUNT')
      if (row) ids.add(row.id)
    }
    return ids
  }, [activations, session])

  function rowState(a: PromoActivation): RowState {
    if (activeId.has(a.id)) return 'active'
    const expired =
      !a.promocodeIsActive || (a.expiresAt !== null && new Date(a.expiresAt).getTime() < Date.now())
    return expired ? 'expired' : 'applied'
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-zinc-300">{t('promo.history')}</p>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : activations.length === 0 ? (
        <div className="rounded-2xl border border-white/6 bg-white/2 p-6 text-center">
          <Gift className="mx-auto h-8 w-8 text-zinc-600" />
          <p className="mt-2 text-xs text-zinc-500">{t('promo.historyEmpty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {activations.map((a, i) => {
            const meta = rewardMeta(a.rewardType)
            const Icon = meta.icon
            const state = rowState(a)
            const value = formatRewardValue(a, t)
            const typeLabel = t(`promo.historyMeta.rewardTypes.${a.rewardType}`, {
              defaultValue: a.rewardType,
            })
            const statusCls =
              state === 'active'
                ? meta.activeBadge
                : state === 'expired'
                  ? 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            const statusLabel =
              state === 'active'
                ? t('promo.historyMeta.status.active')
                : state === 'expired'
                  ? t('promo.historyMeta.status.expired')
                  : t('promo.historyMeta.status.applied')
            return (
              <motion.div
                key={a.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.3) }}
                className={`flex items-center gap-3 rounded-2xl border p-3.5 transition-colors ${
                  state === 'active'
                    ? 'border-white/12 bg-white/4'
                    : state === 'expired'
                      ? 'border-white/6 bg-white/2 opacity-60'
                      : 'border-white/6 bg-white/2'
                }`}
              >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${meta.tile}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-mono text-sm font-medium text-zinc-200">{a.code || '—'}</p>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusCls}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {typeLabel}
                    {value ? ` • ${value}` : ''}
                    {a.activatedAt ? ` • ${formatDateTime(a.activatedAt)}` : ''}
                  </p>
                </div>
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}
