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
import { useSearchParams } from 'react-router'
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

  // WHICH subscription. The dashboard hands the id over in the query string,
  // exactly as it does for add-ons: a customer can hold several, the button
  // belongs to one card, and nothing on this screen names the subscription — so
  // handing over the first one in the list would give somebody another
  // subscription's key with no way to notice. An expired one with a live url
  // sorts first just as easily as the one they just paid for.
  const [searchParams] = useSearchParams()
  const wantedId = searchParams.get('subscriptionId')

  // `getAllSubscriptions` answers `{ subscriptions: [...] }`, not an array.
  // Reading it as one made this screen hand over nothing at all, for everybody:
  // `Array.isArray` narrows to `any[]`, so the compiler had no complaint and
  // every button that needs the link silently disappeared.
  const subscription = useMemo(() => {
    const list = subscriptions.data?.subscriptions ?? []
    const byId = wantedId === null ? undefined : list.find((s) => s.id === wantedId)
    return byId ?? list.find((s) => (s.url ?? '').length > 0) ?? list[0] ?? null
  }, [subscriptions.data, wantedId])
  const subscriptionUrl = subscription?.url ?? ''
  /** The read failed, so "no link" is not something we know. */
  const linkUnknown = subscriptions.isError

  const detected = useMemo(() => detectCurrentPlatform(), [])
  const [platformId, setPlatformId] = useState<PlatformId | null>(null)
  const [appId, setAppId] = useState<string | null>(null)

  // Settles once the catalog arrives, and only for what the customer has not
  // chosen by hand — but it also has to re-settle when the chosen platform
  // STOPS EXISTING. An operator removing a platform (which is what the
  // invalidate webhook exists to deliver promptly) otherwise left the screen
  // with a selection that matches nothing: no platform block, no picker, and no
  // "unavailable" line either, because that one hangs off a missing catalog.
  // A dead screen only a reload could fix.
  useEffect(() => {
    if (catalog === null) return
    const available = catalog.platforms
    if (platformId !== null && available.some((p) => p.id === platformId)) return
    const match = available.find((p) => p.id === detected) ?? null
    setPlatformId(match?.id ?? available[0]?.id ?? null)
  }, [catalog, detected, platformId])
  /** True when the catalog has no section for the device we detected. */
  const platformGuessed =
    catalog !== null && detected !== null && !catalog.platforms.some((p) => p.id === detected)

  const platform: ConnectPlatform | null = useMemo(() => {
    if (catalog === null || platformId === null) return null
    return catalog.platforms.find((p) => p.id === platformId) ?? null
  }, [catalog, platformId])

  const app: ConnectApp | null = useMemo(() => {
    if (platform === null) return null
    return chooseApp(platform, appId ?? rememberedApp(platform.id))
  }, [platform, appId])

  // The selected app can sit off the right edge of the scroller when it was
  // remembered rather than tapped — the strip opens at the start, and the steps
  // below then describe an app the customer cannot see is selected.
  const appStrip = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const selected = appStrip.current?.querySelector('[aria-pressed="true"]')
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [app?.id])

  const selectApp = (platformKey: PlatformId, nextAppId: string): void => {
    setAppId(nextAppId)
    rememberApp(platformKey, nextAppId)
  }

  /**
   * Answers whether the link actually reached the clipboard.
   *
   * It used to resolve either way, so the caller lit its green tick next to the
   * red failure toast. And `navigator.clipboard` is absent outright in an
   * insecure context and in some in-app browsers — `?.` rather than a bare
   * property read, plus the old `execCommand` path, because "select it yourself"
   * is not an instruction anybody can follow against a one-line truncated url.
   */
  const copyLink = async (): Promise<boolean> => {
    if (subscriptionUrl.length === 0) {
      toast.error(t('connect.noLink'))
      return false
    }
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(subscriptionUrl)
      } else if (!copyViaSelection(subscriptionUrl)) {
        throw new Error('no clipboard')
      }
      toast.success(t('connect.copied'))
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
      return true
    } catch {
      if (copyViaSelection(subscriptionUrl)) {
        toast.success(t('connect.copied'))
        return true
      }
      toast.error(t('connect.copyFailed'))
      return false
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
        <CopyCard
          url={subscriptionUrl}
          onCopy={copyLink}
          label={t('connect.copyLink')}
          // "Not known" and "not there yet" are different answers, and the
          // neighbour screen already learned this the hard way: a failed read
          // has no rows either, and printing the empty-state text over it tells
          // the customer their subscription is not ready when it is.
          hint={linkUnknown ? t('connect.linkUnknown') : t('connect.copyHint')}
        />

        {loading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

        {!loading && catalog === null && (
          <p className="text-sm text-muted-foreground">{t('connect.catalogUnavailable')}</p>
        )}

        {catalog !== null && platform !== null && (
          <>
            {platformGuessed && (
              <p className="text-xs text-[color:var(--brand-muted-foreground)]">
                {t('connect.noSectionForDevice')}
              </p>
            )}

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
              <div
                ref={appStrip}
                role="group"
                aria-label={t('connect.appsForPlatform')}
                className="flex gap-2 overflow-x-auto pb-1"
              >
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
  onCopy: () => Promise<boolean>
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
          // Only on a real success. It used to tick regardless, so a failed
          // copy showed a green check beside its own red error toast.
          void onCopy().then((copied) => {
            if (!copied) return
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
  onCopy: () => Promise<boolean>
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
      className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-[color:var(--brand-primary)] px-4 py-2 text-sm font-medium text-[color:var(--brand-primary-fg)]"
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
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-0 h-4 w-4 text-[color:var(--brand-muted-foreground)]" />
      </span>
    </label>
  )
}

/**
 * The last-resort copy: put the link in a field, select it, ask the document.
 *
 * `navigator.clipboard` is absent in an insecure context and in several in-app
 * browsers, and "select the link and copy it yourself" is not an instruction
 * anybody can follow against a one-line truncated address.
 */
function copyViaSelection(value: string): boolean {
  try {
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    const copied = document.execCommand('copy')
    field.remove()
    return copied
  } catch {
    return false
  }
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
  // Same test the catalog reader applied, on the value it stored — it now
  // trims there, so these two no longer disagree about a leading space.
  if (typeof markup !== 'string' || !markup.startsWith('<svg')) return <>{fallback ?? null}</>
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 [&>svg]:h-5 [&>svg]:w-5"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
