import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useBranding } from '@/lib/branding-provider'
import {
  externalStartPath,
  externalTelegramCallbackPath,
  getExternalProviders,
  type PublicExternalProvider,
} from '@/lib/api-client'
import { ProviderIcon } from './provider-icons'

/**
 * Renders the enabled external sign-in options below the login / register form.
 *
 * - OAuth providers (Google/Yandex/Mail.ru) are full-page redirect links to the
 *   BFF `/start` route.
 * - Telegram has TWO modes (chosen by the operator in the admin panel):
 *   - `oidc`  → a redirect link to `/auth/ext/telegram/start` (oauth.telegram.org).
 *   - `widget`→ the official Login Widget script (needs the bot username from
 *     the public config) which redirects to the BFF callback itself.
 *
 * Renders nothing when no providers are enabled.
 *
 * The row is the upstream one: a round chip per provider (border + surface
 * fill) with the provider's own brand icon inside — that look is what the owner
 * asked to keep. Which providers are in the row still comes from the server
 * response, not from a hardcoded allow-list, so switching Yandex or Mail.ru on
 * in the panel adds a chip here with no code change.
 */
export function ExternalAuthButtons() {
  const { t } = useTranslation()
  const { botUsername } = useBranding()

  const { data: providers = [] } = useQuery<PublicExternalProvider[]>({
    queryKey: ['ext-auth', 'providers'],
    queryFn: getExternalProviders,
    staleTime: 300_000,
    retry: false,
  })

  // Every provider but Telegram is a full-page OAuth redirect.
  const oauth = providers.filter((p) => p.provider !== 'TELEGRAM')
  const telegram = providers.find((p) => p.provider === 'TELEGRAM')
  const telegramOidc = telegram?.mode === 'oidc'
  // Widget needs the bot username; OIDC does not (it redirects to Telegram).
  const telegramWidget = Boolean(telegram) && !telegramOidc && Boolean(botUsername)

  if (oauth.length === 0 && !telegramOidc && !telegramWidget) return null

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-[color:var(--color-border-soft)]" />
        <span className="text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.orContinueWith')}</span>
        <span className="h-px flex-1 bg-[color:var(--color-border-soft)]" />
      </div>

      {/* Round brand-icon chips under the sign-in button. */}
      {(oauth.length > 0 || telegramOidc) && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {oauth.map((p) => (
            <ProviderChip key={p.provider} provider={p.provider} displayName={p.displayName} />
          ))}
          {telegramOidc && telegram && (
            <ProviderChip provider="TELEGRAM" displayName={telegram.displayName} />
          )}
        </div>
      )}

      {telegramWidget && botUsername && <TelegramLoginWidget botUsername={botUsername} />}
    </div>
  )
}

/**
 * One round chip: border + surface fill, the provider's brand icon inside.
 *
 * Hover does NOT restyle the circle — the owner wanted the ring to stay put and
 * only the mark inside to lift and grow, so the chip reads as a lens over the
 * icon rather than as a highlighted button. Keyboard focus gets the same lift
 * plus a focus ring, so the effect is not mouse-only.
 */
function ProviderChip({ provider, displayName }: { provider: string; displayName: string }) {
  const { t } = useTranslation()
  const label = t('auth.continueWith', { provider: displayName })

  return (
    <a
      href={externalStartPath(provider)}
      title={label}
      aria-label={label}
      className="group flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)] outline-none focus-visible:ring-2 focus-visible:ring-(--brand-ink)/60 focus-visible:ring-offset-2 focus-visible:ring-offset-(--brand-bg-primary)"
    >
      <span className="flex h-5 w-5 items-center justify-center transition-[scale,translate] duration-200 ease-out group-hover:-translate-y-px group-hover:scale-[1.35] group-focus-visible:-translate-y-px group-focus-visible:scale-[1.35]">
        <ProviderIcon provider={provider} className="h-5 w-5 shrink-0" />
      </span>
    </a>
  )
}

/**
 * Injects the Telegram Login Widget. The widget renders its own button and,
 * on success, redirects the browser to `data-auth-url` (the BFF callback) with
 * the signed payload as query params.
 */
function TelegramLoginWidget({ botUsername }: { botUsername: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.replaceChildren()
    const script = document.createElement('script')
    script.async = true
    // Telegram serves this SDK with permissive CORS. Opting in preserves the
    // actual source/stack in window.error instead of a masked "Script error.".
    script.crossOrigin = 'anonymous'
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.setAttribute('data-telegram-login', botUsername.replace(/^@/, ''))
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '12')
    script.setAttribute('data-auth-url', `${window.location.origin}${externalTelegramCallbackPath()}`)
    script.setAttribute('data-request-access', 'write')
    container.appendChild(script)
    return () => container.replaceChildren()
  }, [botUsername])

  return <div ref={containerRef} className="flex w-full justify-center" />
}
