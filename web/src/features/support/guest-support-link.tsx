import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { LifeBuoy } from 'lucide-react'

import { getGuestSupportConfig } from '@/lib/api-client'

/**
 * Discreet entry point to the anonymous (guest) support chat, shown on the
 * unauthenticated web auth screens (sign-in / register / recover).
 *
 * Only web users ever see those screens — Telegram Mini App users are always
 * authenticated via Telegram and are routed away from `/sign-in` — so this is
 * inherently a web-only affordance, matching the guest chat's public-web scope.
 *
 * Renders nothing until the guest-support config resolves as `enabled`, so the
 * link never appears when the operator has switched the anonymous chat off.
 * Shares the `['guest-support-config']` query key with the guest support page
 * so the config is fetched once and cached across the flow.
 */
export function GuestSupportLink() {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['guest-support-config'],
    queryFn: getGuestSupportConfig,
    staleTime: Infinity,
  })

  if (!data?.enabled) return null

  return (
    <Link
      to="/support/guest"
      className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-400 backdrop-blur-xl transition-colors hover:border-(--brand-primary)/40 hover:text-white"
    >
      <LifeBuoy className="h-3.5 w-3.5" />
      {t('guestSupport.entry')}
    </Link>
  )
}
