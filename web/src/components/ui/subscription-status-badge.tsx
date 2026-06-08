import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

type SubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'DISABLED' | 'LIMITED' | 'DELETED' | 'TRIAL'

interface StatusBadgeProps {
  status: SubscriptionStatus | string
  className?: string
}

const statusConfig: Record<string, { labelKey: string; classes: string }> = {
  ACTIVE:   { labelKey: 'statusBadge.ACTIVE',   classes: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  LIMITED:  { labelKey: 'statusBadge.LIMITED',  classes: 'bg-amber-500/20   text-amber-400   border-amber-500/30' },
  EXPIRED:  { labelKey: 'statusBadge.EXPIRED',  classes: 'bg-red-500/20     text-red-400     border-red-500/30' },
  DISABLED: { labelKey: 'statusBadge.DISABLED', classes: 'bg-zinc-700/50    text-zinc-400    border-zinc-600/30' },
  DELETED:  { labelKey: 'statusBadge.DELETED',  classes: 'bg-zinc-800/50    text-zinc-500    border-zinc-700/30' },
  TRIAL:    { labelKey: 'statusBadge.TRIAL',    classes: 'bg-violet-500/20  text-violet-400  border-violet-500/30' },
}

export function SubscriptionStatusBadge({ status, className }: StatusBadgeProps) {
  const { t } = useTranslation()
  const config = statusConfig[status]
  const label = config ? t(config.labelKey) : status
  const classes = config?.classes ?? 'bg-zinc-700/50 text-zinc-400 border-zinc-600/30'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        classes,
        className,
      )}
    >
      {label}
    </span>
  )
}
