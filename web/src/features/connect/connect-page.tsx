/**
 * Connect screen — how a customer gets their subscription into a VPN app.
 *
 * This replaces a redirect to an external subscription page, and the point is
 * not that it saves a hop. It is that a page reached by a link knows nothing
 * about who opened it, so it has to ask: the page we used to send people to
 * opens with a dropdown of seven platforms and the same instructions for
 * everyone. The cabinet is already running on the device, already knows the
 * subscription, and can remember what this person used last time.
 *
 * ── What is deliberately NOT on this screen ──────────────────────────────────
 *
 * The username, status, expiry and traffic tiles. The external page shows them
 * because it is a whole page and has nothing else to open with; here the
 * customer arrived by tapping a card that shows all four. Repeating them would
 * be the same four numbers twice on two screens.
 *
 * ── Degrading ────────────────────────────────────────────────────────────────
 *
 * The catalog comes from the panel and the panel can be down. The subscription
 * link does NOT — it is on the card this screen was opened from. So when the
 * catalog is missing the screen still does the one thing that always works:
 * hand over the link. That is why "copy" is never rendered from the catalog
 * alone.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, ExternalLink, Link2 } from 'lucide-react'
import { toast } from 'sonner'

import { getAllSubscriptions, getConnectPage } from '@/lib/api-client'
import { subscriptionQueryKeys } from '@/lib/subscription-query-keys'
import { BackButton } from '@/components/ui/back-button'
import { StadiumButton } from '@/components/ui/stadium-button'
import { LoadErrorCard } from '@/components/ui/load-error-card'
import { openExternalUrl } from '@/lib/utils'
import {
  buildDeepLink,
  chooseApp,
  line,
  readCatalog,
  type ConnectApp,
  type ConnectButton,
  type ConnectPlatform,
  type PlatformId,
} from './connect-catalog'
import { detectCurrentPlatform, rememberApp, rememberedApp } from './platform-detect'

export default function ConnectPage() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language.slice(0, 2)

  // The same query key the dashboard uses, so the screen shares its cache and
  // a link rotated on the card is the link this screen hands over.
  const subscriptions = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 30_000,
  })
  const catalogQuery = useQuery({
    queryKey: ['connect-page'],
    queryFn: getConnectPage,
    staleTime: 60_000,
  })

  const catalog = useMemo(() => readCatalog(catalogQuery.data), [catalogQuery.data])

  // The link this screen hands over. Read fresh from the subscription list
  // rather than captured on mount: regenerating a link rotates it, and a copy
  // taken at mount would hand out an address that stopped working while the
  // screen was open.
  const subscription = useMemo(() => {
    const list = Array.isArray(subscriptions.data) ? subscriptions.data : []
    return list.find((s) => typeof s?.url === 'string' && s.url.length > 0) ?? list[0] ?? null
  }, [subscriptions.data])
  const subscriptionUrl = typeof subscription?.url === 'string' ? subscription.url : ''

  const detected = useMemo(() => detectCurrentPlatform(), [])
  const [platformId, setPlatformId] = useState<PlatformId | null>(null)
  const [appId, setAppId] = useState<string | null>(null)

  // Settles once the catalog arrives, and only for what the customer has not
  // chosen by hand: re-running detection over a manual pick would undo it on
  // the next refetch.
  useEffect(() => {
    if (catalog === null || platformId !== null) return
    const available = catalog.platforms
    const match = available.find((p) => p.id === detected) ?? null
    setPlatformId(match?.id ?? available[0]?.id ?? null)
  }, [catalog, detected, platformId])

  const platform: ConnectPlatform | null = useMemo(() => {
    if (catalog === null || platformId === null) return null
    return catalog.platforms.find((p) => p.id === platformId) ?? null
  }, [catalog, platformId])

  const app: ConnectApp | null = useMemo(() => {
    if (platform === null) return null
    return chooseApp(platform, appId ?? rememberedApp(platform.id))
  }, [platform, appId])

  const selectApp = (platformKey: PlatformId, nextAppId: string): void => {
    setAppId(nextAppId)
    rememberApp(platformKey, nextAppId)
  }

  const copyLink = async (): Promise<void> => {
    if (subscriptionUrl.length === 0) {
      toast.error(t('connect.noLink'))
      return
    }
    try {
      await navigator.clipboard.writeText(subscriptionUrl)
      toast.success(t('connect.copied'))
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
    } catch {
      toast.error(t('connect.copyFailed'))
    }
  }

  const loading = subscriptions.isLoading || catalogQuery.isLoading

  return (
    <div className="pb-10">
      <div className="flex items-center gap-3 px-5 py-5">
        <BackButton fallback="/dashboard" label={t('common.back')} />
        <div>
          <h1 className="text-lg font-semibold">{t('connect.pageTitle')}</h1>
          <p className="text-xs text-muted-foreground">
            {platform === null ? t('connect.subtitle') : line(platform.title, locale)}
          </p>
        </div>
      </div>

      <div className="space-y-4 px-5">
        {subscriptions.isError && (
          <LoadErrorCard
            title={t('connect.linkFailedTitle')}
            body={t('connect.linkFailedBody')}
            retryLabel={t('common.retry')}
            pending={subscriptions.isFetching}
            onRetry={() => {
              void subscriptions.refetch()
            }}
          />
        )}

        {/* Always available, catalog or not: this is the action that never
            depends on the panel being up. */}
        <CopyCard url={subscriptionUrl} onCopy={copyLink} label={t('connect.copyLink')} hint={t('connect.copyHint')} />

        {loading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

        {!loading && catalog === null && (
          <p className="text-sm text-muted-foreground">{t('connect.catalogUnavailable')}</p>
        )}

        {catalog !== null && platform !== null && (
          <>
            <PlatformPicker
              platforms={catalog.platforms}
              value={platform.id}
              locale={locale}
              label={t('connect.platform')}
              onChange={(next) => {
                setPlatformId(next)
                setAppId(null)
              }}
            />

            {platform.apps.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {platform.apps.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => selectApp(platform.id, candidate.id)}
                    aria-pressed={candidate.id === app?.id}
                    className={
                      candidate.id === app?.id
                        ? 'flex shrink-0 items-center gap-2 rounded-[var(--radius-item)] border border-[color:var(--brand-primary)] bg-[color:var(--color-surface-high)] px-3 py-2 text-sm font-medium'
                        : 'flex shrink-0 items-center gap-2 rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] px-3 py-2 text-sm text-[color:var(--brand-muted-foreground)]'
                    }
                  >
                    <Icon markup={catalog.icons[candidate.iconKey ?? '']} />
                    {candidate.name}
                  </button>
                ))}
              </div>
            )}

            {app !== null &&
              app.steps.map((step, index) => (
                <section
                  key={`${app.id}-${index}`}
                  className="rounded-[var(--radius-card)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] p-4"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 text-[color:var(--brand-primary)]">
                      <Icon markup={catalog.icons[step.iconKey ?? '']} fallback={<Link2 className="h-5 w-5" />} />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <h2 className="text-sm font-semibold">{line(step.title, locale)}</h2>
                      {step.body !== null && (
                        <p className="text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">
                          {line(step.body, locale)}
                        </p>
                      )}
                    </div>
                  </div>

                  {step.buttons.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {step.buttons.map((btn, btnIndex) => (
                        <StepButton
                          key={btnIndex}
                          button={btn}
                          locale={locale}
                          subscriptionUrl={subscriptionUrl}
                          onCopy={copyLink}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ))}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The one card that is rendered from the cabinet's own data.
 *
 * On the page we redirect to today the equivalent is a paragraph near the
 * bottom under "if the subscription was not added" — an admission that the
 * scheme does not always fire, filed where nobody looks. Here it is the first
 * thing on the screen and it works when everything else does not.
 */
function CopyCard({
  url,
  onCopy,
  label,
  hint,
}: {
  url: string
  onCopy: () => Promise<void>
  label: string
  hint: string
}) {
  const [done, setDone] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  return (
    <div className="rounded-[var(--radius-card)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)] p-4">
      <p className="mb-2 truncate font-mono text-xs text-[color:var(--brand-muted-foreground)]">
        {url.length > 0 ? url : hint}
      </p>
      <StadiumButton
        className="w-full"
        disabled={url.length === 0}
        onClick={() => {
          void onCopy().then(() => {
            setDone(true)
            if (timer.current !== null) window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setDone(false), 2_000)
          })
        }}
      >
        {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {label}
      </StadiumButton>
    </div>
  )
}

function StepButton({
  button,
  locale,
  subscriptionUrl,
  onCopy,
}: {
  button: ConnectButton
  locale: string
  subscriptionUrl: string
  onCopy: () => Promise<void>
}) {
  const label = line(button.label, locale)

  if (button.kind === 'copyLink') {
    return (
      <StadiumButton variant="secondary" onClick={() => void onCopy()} disabled={subscriptionUrl.length === 0}>
        <Copy className="h-4 w-4" />
        {label}
      </StadiumButton>
    )
  }

  if (button.kind === 'external') {
    return (
      <StadiumButton variant="secondary" onClick={() => openExternalUrl(button.url)}>
        <ExternalLink className="h-4 w-4" />
        {label}
      </StadiumButton>
    )
  }

  const href = buildDeepLink(button, subscriptionUrl)
  if (href === null) return null

  // A real anchor, not a click handler that navigates. A custom scheme leaves
  // the page through the host's own link handling, and inside Telegram that
  // handling is what passes the scheme to the operating system — a scripted
  // navigation is the shape that gets swallowed.
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 rounded-full bg-[color:var(--brand-primary)] px-4 py-2 text-sm font-medium text-[color:var(--brand-primary-foreground)]"
      onClick={() => window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium')}
    >
      <Link2 className="h-4 w-4" />
      {label}
    </a>
  )
}

function PlatformPicker({
  platforms,
  value,
  locale,
  label,
  onChange,
}: {
  platforms: readonly ConnectPlatform[]
  value: PlatformId
  locale: string
  label: string
  onChange: (next: PlatformId) => void
}) {
  // Kept even though the platform is detected: detection reads a string the
  // browser chooses to send, and every "request desktop site" toggle exists to
  // make it lie. A wrong guess costs one tap; asking everyone costs it always.
  return (
    <label className="flex items-center justify-between gap-3 rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] px-3 py-2">
      <span className="text-xs text-[color:var(--brand-muted-foreground)]">{label}</span>
      <span className="relative flex items-center gap-1">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as PlatformId)}
          className="appearance-none bg-transparent pr-5 text-sm font-medium outline-none"
        >
          {platforms.map((platform) => (
            <option key={platform.id} value={platform.id}>
              {line(platform.title, locale)}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-0 h-4 w-4 text-[color:var(--brand-muted-foreground)]" />
      </span>
    </label>
  )
}

/**
 * An operator's icon.
 *
 * The markup was sanitized in the panel — allow-listed elements and attributes,
 * every handler and every outward reference stripped — which is why it can be
 * injected here at all. The cabinet does not sanitize it again because it
 * cannot do it better than the side that saw the write, and a second, different
 * sanitizer is a second opinion about what the string means.
 */
function Icon({ markup, fallback }: { markup?: string; fallback?: React.ReactNode }) {
  if (typeof markup !== 'string' || !markup.startsWith('<svg')) return <>{fallback ?? null}</>
  return <span className="inline-flex h-5 w-5 [&>svg]:h-5 [&>svg]:w-5" dangerouslySetInnerHTML={{ __html: markup }} />
}
