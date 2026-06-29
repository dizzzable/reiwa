import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Shield } from 'lucide-react'
import { getPlans } from '@/lib/api-client'
import type { Plan } from '@/types/api'
import { usePurchaseStore } from '@/stores/purchase.store'
import { useBranding } from '@/lib/branding-provider'
import { cn } from '@/lib/utils'
import { BackButton } from '@/components/ui/back-button'
import { CustomIconView } from '@/components/ui/custom-icon-view'
import { EmojiText } from '@/components/ui/emoji-text'
import { CardWatermark } from '@/components/ui/card-watermark'
import { customIconId, isEmojiIcon, resolvePlanIcon } from './plan-icons'
import { resolvePlanCardStyle } from './plan-card-visual'

/**
 * Lowest price for a plan, expressed in the preferred display currency
 * when the plan has a price in it. Falls back to USD → RUB → whatever is
 * configured. Pure display selection — no conversion.
 */
function getLowestPrice(
  plan: Plan,
  preferredCurrency: string,
): { amount: number; currency: string; days: number } | null {
  // Prefer the gateway-aware prices (they carry the user's discounts). When no
  // payment gateway is active those are empty, so fall back to the operator's
  // configured `displayPrices` so the card still shows a price.
  const gatewayPrices = plan.durations.flatMap(d =>
    d.prices.map(p => ({ currency: p.currency, amount: Number(p.price), days: d.days })),
  )
  const displayPrices = (plan.displayPrices ?? []).map(p => ({
    currency: p.currency,
    amount: Number(p.price),
    days: p.days,
  }))
  const allPrices = gatewayPrices.length ? gatewayPrices : displayPrices
  if (!allPrices.length) return null
  const preferred = allPrices.filter(p => p.currency === preferredCurrency)
  const usd = allPrices.filter(p => p.currency === 'USD')
  const rub = allPrices.filter(p => p.currency === 'RUB')
  const list = preferred.length ? preferred : usd.length ? usd : rub.length ? rub : allPrices
  const minDays = Math.min(...allPrices.map(p => p.days))
  const minPrice = list.reduce((min, p) => (p.amount < min.amount ? p : min), list[0])
  return { amount: minPrice.amount, currency: minPrice.currency, days: minDays }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', RUB: '₽', USDT: '$', TON: 'TON',
}

export default function PlansPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { selectPlan } = usePurchaseStore()
  const { branding, defaultCurrency, customIcons } = useBranding()

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['plans'],
    queryFn: getPlans,
    staleTime: 300_000,
  })

  // The public catalog endpoint (`/api/v1/plans` → rezeis
  // `getCatalogPlans`) already returns ONLY active, non-archived,
  // context-available plans. The payload intentionally omits
  // `isActive`/`isArchived`, so filtering on them here hid every plan
  // (both were `undefined`). Trust the backend's filtering.
  //
  // Free trials are CLAIMED (not bought) via the dashboard TrialCta
  // (`activateTrial`), so they must not appear in the paid "Buy" catalog —
  // otherwise a plan flipped from paid→free trial lingers here as a phantom
  // priced slot that errors on click. Paid trials (`trialFree === false`)
  // stay purchasable.
  const activePlans = plans.filter((p) => !(p.isTrial && p.trialFree))

  function handleSelect(plan: Plan) {
    selectPlan(plan)
    navigate('/purchase')
  }

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <BackButton fallback="/dashboard" label={t('common.back')} />
        <div>
          <h1 className="text-lg font-semibold">{t('plans.title')}</h1>
          <p className="text-xs text-zinc-500">{t('plans.subtitle')}</p>
        </div>
      </div>

      <div className="px-5 space-y-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[150px] animate-pulse rounded-card bg-zinc-800/50" />
          ))
        ) : activePlans.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-zinc-500">
            <Shield className="h-12 w-12 opacity-30" />
            <p>{t('plans.emptyAvailable')}</p>
          </div>
        ) : (
          activePlans.map((plan, i) => {
            const price = getLowestPrice(plan, defaultCurrency)
            const customId = customIconId(plan.icon)
            const custom = customId ? customIcons.find((c) => c.id === customId) : undefined
            const Icon = resolvePlanIcon(plan.icon, plan.type)
            // Per-plan visual (operator-configured via WEB Reiwa, keyed by
            // planId) → else a deterministic auto gradient so every plan
            // (including archived/unconfigured) still reads as distinct.
            const visual = resolvePlanCardStyle(String(plan.id), branding)
            const accent = visual.accent ?? branding.primary

            return (
              <motion.button
                key={plan.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                onClick={() => handleSelect(plan)}
                className={cn(
                  '@container/card group relative flex min-h-[150px] w-full flex-col justify-between',
                  'overflow-hidden rounded-card p-5 text-left text-white select-none',
                  'shadow-xl shadow-black/40 ring-1 ring-white/10',
                  'transition-transform duration-150 active:scale-[0.98]',
                )}
              >
                {/* Static foundation: dark base + per-plan gradient */}
                <div className="absolute inset-0 -z-30 bg-zinc-950" />
                <div
                  className="absolute inset-0 -z-25"
                  style={{ backgroundImage: visual.gradient }}
                />
                {/* Texture overlay: uploaded image (cover) wins over a preset
                    tiled pattern. The panel embeds the operator's image here. */}
                {visual.textureUrl ? (
                  <div
                    className="absolute inset-0 -z-20 bg-cover bg-center opacity-25"
                    style={{ backgroundImage: `url(${visual.textureUrl})` }}
                  />
                ) : visual.textureImage ? (
                  <div
                    className="absolute inset-0 -z-20"
                    style={{
                      backgroundImage: visual.textureImage,
                      backgroundSize: visual.textureSize ?? undefined,
                    }}
                  />
                ) : null}
                {/* Vignette so text stays legible over any gradient/texture */}
                <div className="absolute inset-0 -z-10 bg-linear-to-br from-black/35 via-black/10 to-black/55" />

                {/* Brand watermark — operator glyph or custom image, faint */}
                <CardWatermark
                  preset={branding.cardLogo}
                  customUrl={branding.cardLogoUrl}
                  className="absolute -right-5 -bottom-7 h-32 w-32 @sm:h-36 @sm:w-36"
                />

                {/* Top: clean plan icon (no chip) + name + traffic/devices */}
                <div className="relative flex items-start gap-3.5">
                  <div className="shrink-0 leading-none drop-shadow" style={{ color: accent }}>
                    {isEmojiIcon(plan.icon) ? (
                      <EmojiText text={plan.icon} className="text-3xl leading-none" />
                    ) : custom ? (
                      <CustomIconView url={custom.url} color={custom.color} className="h-9 w-9" />
                    ) : (
                      <Icon className="h-8 w-8" strokeWidth={1.75} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-base font-semibold tracking-wide drop-shadow">
                        {plan.name}
                      </p>
                      {plan.isTrial && (
                        <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase backdrop-blur-md">
                          {t('plans.trialBadge')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] font-medium text-white/85">
                      {plan.trafficLimit ? `${plan.trafficLimit} GB` : t('plans.unlimited')}
                      {plan.deviceLimit
                        ? ` · ${t('plans.devicesSuffix', { count: plan.deviceLimit })}`
                        : ''}
                    </p>
                    {plan.description && (
                      <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-white/65">
                        {plan.description}
                      </p>
                    )}
                  </div>
                </div>

                {/* Bottom: duration options (left) + lowest price (right) */}
                <div className="relative flex items-end justify-between gap-2">
                  <p className="text-[11px] tracking-wider text-white/55 uppercase">
                    {t('plans.durationOptions', { count: plan.durations.length })}
                  </p>
                  {price && (
                    <div className="text-right">
                      <p className="text-lg font-bold drop-shadow" style={{ color: accent }}>
                        {t('plans.from')} {CURRENCY_SYMBOLS[price.currency] ?? ''}
                        {price.amount.toFixed(2)}
                      </p>
                      <p className="text-[11px] text-white/60">
                        /{price.days} {t('plans.daysShort')}
                      </p>
                    </div>
                  )}
                </div>
              </motion.button>
            )
          })
        )}
      </div>
    </div>
  )
}
