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

const OAUTH_PROVIDERS = new Set(['GOOGLE', 'YANDEX', 'MAILRU'])

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

  const oauth = providers.filter((p) => OAUTH_PROVIDERS.has(p.provider))
  const telegram = providers.find((p) => p.provider === 'TELEGRAM')
  const telegramOidc = telegram?.mode === 'oidc'
  // Widget needs the bot username; OIDC does not (it redirects to Telegram).
  const telegramWidget = Boolean(telegram) && !telegramOidc && Boolean(botUsername)

  if (oauth.length === 0 && !telegramOidc && !telegramWidget) return null

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-white/10" />
        <span className="text-xs text-zinc-500">{t('auth.orContinueWith')}</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      {/* Compact row of round brand-icon buttons under the sign-in button. */}
      {(oauth.length > 0 || telegramOidc) && (
        <div className="flex items-center justify-center gap-3">
          {oauth.map((p) => (
            <a
              key={p.provider}
              href={externalStartPath(p.provider)}
              title={t('auth.continueWith', { provider: p.displayName })}
              aria-label={t('auth.continueWith', { provider: p.displayName })}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-zinc-900/80 transition-colors hover:border-(--brand-primary)/50 hover:bg-zinc-800/80"
            >
              <ProviderIcon provider={p.provider} className="h-5 w-5 shrink-0" />
            </a>
          ))}
          {telegramOidc && telegram && (
            <a
              href={externalStartPath('TELEGRAM')}
              title={t('auth.continueWith', { provider: telegram.displayName })}
              aria-label={t('auth.continueWith', { provider: telegram.displayName })}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-zinc-900/80 transition-colors hover:border-(--brand-primary)/50 hover:bg-zinc-800/80"
            >
              <ProviderIcon provider="TELEGRAM" className="h-5 w-5 shrink-0" />
            </a>
          )}
        </div>
      )}

      {telegramWidget && botUsername && <TelegramLoginWidget botUsername={botUsername} />}
    </div>
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
