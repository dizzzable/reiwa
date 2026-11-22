import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

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
 *
 * Shape (the owner's call, 22.11): a glass pill from the same vocabulary as the
 * entry sheet, centred under the actions and only as wide as its caption — NOT
 * a full-width button, and not a second brand-coloured CTA. The support way out
 * is optional, so it keeps the muted caption colour it always had; only its
 * surface became glass. The lifebuoy glyph and the «Нужна помощь?» lead-in are
 * gone: the caption alone says what the control does (`guestSupport.entry`).
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
    <Link to="/support/guest" className="support-glass">
      {t('guestSupport.entry')}
    </Link>
  )
}
