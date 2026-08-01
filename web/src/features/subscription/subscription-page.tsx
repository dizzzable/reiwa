import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { ShoppingCart, RotateCcw, Copy, ExternalLink, Wifi, WifiOff } from 'lucide-react'
import { getSubscription, getActionPolicy } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'
import { BackButton } from '@/components/ui/back-button'
import { SubscriptionStatusBadge } from '@/components/ui/subscription-status-badge'
import { TipCard } from '@/components/ui/tip-card'
import {
  isSubscriptionLimitReached,
  notifySubscriptionLimitReached,
} from '@/lib/subscription-limit'
import { formatDate, getDaysLeft } from '@/lib/utils'
import { toast } from 'sonner'
import { subscriptionQueryKeys } from '@/lib/subscription-query-keys'
import { canRenewSubscription } from '@/features/dashboard/components/subscription-action-policy'

export default function SubscriptionPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const renewalReasonId = useId()

  const { data: sub, isLoading } = useQuery({
    queryKey: subscriptionQueryKeys.detail,
    queryFn: getSubscription,
    retry: false,
  })

  const { data: policy } = useQuery({
    queryKey: subscriptionQueryKeys.actionPolicy(sub?.id ?? null),
    queryFn: () => getActionPolicy(sub?.id),
    enabled: !isLoading,
    // Always load capacity — needed even when there is no "current" sub row
    // (empty account / multi-sub portfolio edge cases).
    staleTime: 30_000,
  })

  const daysLeft = sub?.expireAt ? getDaysLeft(sub.expireAt) : null
  const isExpiringSoon = daysLeft !== null && daysLeft <= 3 && (sub?.status === 'ACTIVE' || sub?.status === 'LIMITED')
  const canRenew = canRenewSubscription(sub ?? null, false, policy?.canRenew)
  const trialRenewalReason = sub?.isTrial === true ? t('renewal.reason.trial') : null

  function copyUrl() {
    if (!sub?.url) return
    navigator.clipboard.writeText(sub.url).then(() => toast.success(t('subscription.linkCopied')))
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
        <BackButton fallback="/dashboard" label={t('common.back')} />
        <h1 className="text-lg font-semibold">{t('subscription.pageTitle')}</h1>
      </div>

      {!sub ? (
        <div className="px-5 space-y-4">
          <TipCard tone="info" icon={<WifiOff className="h-4 w-4" />}>
            {t('subscription.noSubTip')}
          </TipCard>
          <StadiumButton
            fullWidth size="lg"
            onClick={() => {
              if (isSubscriptionLimitReached(policy)) {
                notifySubscriptionLimitReached(t, policy)
                return
              }
              navigate('/plans')
            }}
            icon={<ShoppingCart className="h-5 w-5" />}
            glow={!isSubscriptionLimitReached(policy)}
          >
            {t('subscription.choosePlan')}
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
                <p className="text-lg font-semibold">{sub.plan?.name ?? t('subscription.planFallback')}</p>
                {sub.isTrial && <span className="text-xs text-violet-400">{t('subscription.trialPeriod')}</span>}
              </div>
              <SubscriptionStatusBadge status={sub.status} />
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-[color:var(--color-surface-high)] p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('subscription.expires')}</p>
                <p className="mt-1 font-semibold text-foreground">{formatDate(sub.expireAt)}</p>
                {daysLeft !== null && (
                  <p className={`text-xs mt-0.5 ${daysLeft <= 3 ? 'text-(--brand-primary)' : 'text-muted-foreground'}`}>
                    {daysLeft === 0 ? t('subscription.today') : t('subscription.daysLeftShort', { count: daysLeft })}
                  </p>
                )}
              </div>
              <div className="rounded-xl bg-[color:var(--color-surface-high)] p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('subscription.traffic')}</p>
                <p className="mt-1 font-semibold text-foreground">
                  {sub.trafficLimit ? `${sub.trafficLimit} GB` : t('subscription.unlimited')}
                </p>
              </div>
              {sub.deviceLimit && (
                <div className="rounded-xl bg-[color:var(--color-surface-high)] p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('subscription.devicesLabel')}</p>
                  <p className="mt-1 font-semibold text-foreground">{sub.deviceLimit}</p>
                </div>
              )}
              <div className="rounded-xl bg-[color:var(--color-surface-high)] p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('subscription.typeLabel')}</p>
                <p className="mt-1 font-semibold text-foreground">{sub.plan?.type ?? '—'}</p>
              </div>
            </div>

            {/* Subscription URL */}
            {sub.url && (
              <div className="flex items-center gap-2 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)] p-3">
                <Wifi className="h-4 w-4 shrink-0 text-emerald-400" />
                <p className="flex-1 truncate text-xs font-mono text-muted-foreground">{sub.url}</p>
                <button onClick={copyUrl} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                  <Copy className="h-4 w-4" />
                </button>
                <a href={sub.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}
          </motion.div>

          {/* Expiry warning */}
          {isExpiringSoon && (
            <TipCard tone="warning">
              {t('subscription.expiresInWarning', { count: daysLeft })}
            </TipCard>
          )}

          {/* Action buttons */}
          <div className="space-y-3">
            {(canRenew || trialRenewalReason) && (
              <StadiumButton
                fullWidth size="lg"
                disabled={!canRenew}
                aria-describedby={trialRenewalReason ? renewalReasonId : undefined}
                onClick={() => {
                  if (canRenew) navigate('/renew')
                }}
                icon={<RotateCcw className="h-5 w-5" />}
                glow={canRenew && isExpiringSoon}
              >
                {t('subscription.renewFull')}
              </StadiumButton>
            )}
            {trialRenewalReason && (
              <p
                id={renewalReasonId}
                role="note"
                className="text-sm leading-relaxed text-muted-foreground"
              >
                {trialRenewalReason}
              </p>
            )}
            {policy?.canBuy && !policy.canRenew && (
              <StadiumButton
                fullWidth size="lg"
                onClick={() => navigate('/plans')}
                icon={<ShoppingCart className="h-5 w-5" />}
                glow
              >
                {t('subscription.buyNew')}
              </StadiumButton>
            )}
            {/* Capacity full: no Buy CTA, only an explanation. Server also
                rejects NEW/ADDITIONAL checkout with SUBSCRIPTION_LIMIT_REACHED. */}
            {isSubscriptionLimitReached(policy) && (
              <TipCard tone="warning">
                {typeof policy?.activeSubscriptionCount === 'number' &&
                typeof policy?.maxSubscriptions === 'number'
                  ? t('subscription.limitReachedDetail', {
                      current: policy.activeSubscriptionCount,
                      max: policy.maxSubscriptions,
                    })
                  : t('subscription.limitReached')}
              </TipCard>
            )}
            {policy?.canUpgrade && (
              <StadiumButton
                fullWidth
                onClick={() => navigate('/upgrade')}
                variant="outline"
              >
                {t('subscription.upgradePlan')}
              </StadiumButton>
            )}
            <StadiumButton
              fullWidth
              onClick={() => navigate('/subscription/devices')}
              variant="secondary"
            >
              📱 {t('subscription.manageDevices')}
            </StadiumButton>
          </div>
        </div>
      )}
    </div>
  )
}
