import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { ArrowLeft, ShoppingCart, RotateCcw, Copy, ExternalLink, Wifi, WifiOff } from 'lucide-react'
import { getSubscription, getActionPolicy } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'
import { SubscriptionStatusBadge } from '@/components/ui/subscription-status-badge'
import { TipCard } from '@/components/ui/tip-card'
import { formatDate, getDaysLeft } from '@/lib/utils'
import { toast } from 'sonner'

export default function SubscriptionPage() {
  const navigate = useNavigate()

  const { data: sub, isLoading } = useQuery({
    queryKey: ['subscription'],
    queryFn: getSubscription,
    retry: false,
  })

  const { data: policy } = useQuery({
    queryKey: ['action-policy'],
    queryFn: () => getActionPolicy(),
    enabled: !!sub,
  })

  const daysLeft = sub?.expireAt ? getDaysLeft(sub.expireAt) : null
  const isExpiringSoon = daysLeft !== null && daysLeft <= 3 && (sub?.status === 'ACTIVE' || sub?.status === 'LIMITED')

  function copyUrl() {
    if (!sub?.url) return
    navigator.clipboard.writeText(sub.url).then(() => toast.success('Ссылка скопирована'))
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="pb-8">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-5">
        <button onClick={() => navigate(-1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 hover:text-white transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">Подписка</h1>
      </div>

      {!sub ? (
        <div className="px-5 space-y-4">
          <TipCard tone="info" icon={<WifiOff className="h-4 w-4" />}>
            У вас нет активной подписки. Купите план для начала работы.
          </TipCard>
          <StadiumButton
            fullWidth size="lg"
            onClick={() => navigate('/plans')}
            icon={<ShoppingCart className="h-5 w-5" />}
            glow
          >
            Выбрать план
          </StadiumButton>
        </div>
      ) : (
        <div className="px-5 space-y-4">
          {/* Main card */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-card p-5 space-y-4"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-lg font-semibold">{sub.plan?.name ?? 'Подписка'}</p>
                {sub.isTrial && <span className="text-xs text-violet-400">Пробный период</span>}
              </div>
              <SubscriptionStatusBadge status={sub.status} />
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-zinc-800/50 p-3">
                <p className="text-xs text-zinc-500 uppercase tracking-wide">Истекает</p>
                <p className="mt-1 font-semibold text-white">{formatDate(sub.expireAt)}</p>
                {daysLeft !== null && (
                  <p className={`text-xs mt-0.5 ${daysLeft <= 3 ? 'text-(--brand-primary)' : 'text-zinc-400'}`}>
                    {daysLeft === 0 ? 'Сегодня' : `${daysLeft} дн.`}
                  </p>
                )}
              </div>
              <div className="rounded-xl bg-zinc-800/50 p-3">
                <p className="text-xs text-zinc-500 uppercase tracking-wide">Трафик</p>
                <p className="mt-1 font-semibold text-white">
                  {sub.trafficLimit ? `${sub.trafficLimit} GB` : 'Безлимит'}
                </p>
              </div>
              {sub.deviceLimit && (
                <div className="rounded-xl bg-zinc-800/50 p-3">
                  <p className="text-xs text-zinc-500 uppercase tracking-wide">Устройств</p>
                  <p className="mt-1 font-semibold text-white">{sub.deviceLimit}</p>
                </div>
              )}
              <div className="rounded-xl bg-zinc-800/50 p-3">
                <p className="text-xs text-zinc-500 uppercase tracking-wide">Тип</p>
                <p className="mt-1 font-semibold text-white">{sub.plan?.type ?? '—'}</p>
              </div>
            </div>

            {/* Subscription URL */}
            {sub.url && (
              <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-zinc-800/30 p-3">
                <Wifi className="h-4 w-4 shrink-0 text-emerald-400" />
                <p className="flex-1 truncate text-xs font-mono text-zinc-400">{sub.url}</p>
                <button onClick={copyUrl} className="shrink-0 text-zinc-500 hover:text-white transition-colors">
                  <Copy className="h-4 w-4" />
                </button>
                <a href={sub.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-zinc-500 hover:text-white transition-colors">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}
          </motion.div>

          {/* Expiry warning */}
          {isExpiringSoon && (
            <TipCard tone="warning">
              Подписка истекает через {daysLeft} {daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}. Продлите сейчас.
            </TipCard>
          )}

          {/* Action buttons */}
          <div className="space-y-3">
            {policy?.canRenew && (
              <StadiumButton
                fullWidth size="lg"
                onClick={() => navigate('/renew')}
                icon={<RotateCcw className="h-5 w-5" />}
                glow={isExpiringSoon}
              >
                Продлить подписку
              </StadiumButton>
            )}
            {policy?.canBuy && !policy.canRenew && (
              <StadiumButton
                fullWidth size="lg"
                onClick={() => navigate('/plans')}
                icon={<ShoppingCart className="h-5 w-5" />}
                glow
              >
                Купить новую подписку
              </StadiumButton>
            )}
            {policy?.canUpgrade && (
              <StadiumButton
                fullWidth
                onClick={() => navigate('/upgrade')}
                variant="outline"
              >
                Улучшить план
              </StadiumButton>
            )}
            <StadiumButton
              fullWidth
              onClick={() => navigate('/subscription/devices')}
              variant="secondary"
            >
              📱 Управление устройствами
            </StadiumButton>
          </div>
        </div>
      )}
    </div>
  )
}
