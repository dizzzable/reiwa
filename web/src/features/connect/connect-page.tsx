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
 * ── The composition is the concept book's, not this file's ───────────────────
 *
 * `V:\Rezeis Subpage\subscription.pen` holds 104 concepts of this screen, and
 * every one of them is the SAME arrangement wearing different tokens: a brand
 * header over a hairline, a 2×2 block of subscription facts, then one workspace
 * card holding the platform picker, a 2×2 grid of apps, and the steps as a
 * single timeline — numbered, divided by hairlines, each with its icon in a
 * ring. What shipped first instead was a stack of separate cards, one per step,
 * which is the habit the concepts exist to avoid: a border around every
 * paragraph flattens the hierarchy until nothing on the screen is louder than
 * anything else.
 *
 * Geometry here is the concept's, in its own numbers — the 22px card radius,
 * the 12px tile padding, the 13px step rhythm, the 4px accent rail. Type is
 * NOT: the artboards set micro-labels at 7px and body at 10px, which is legible
 * on a 2× export and not on a phone, so the scale is lifted to the cabinet's
 * floor while keeping the concept's proportions.
 *
 * ── Handing the raw link over ────────────────────────────────────────────────
 *
 * The concepts put it behind the round link button in the header, and that is
 * where it lives. An earlier draft also carried a card showing the URL above
 * the workspace — not in the book, and removed on the operator's instruction.
 *
 * The property that card existed to guarantee is unchanged, because the header
 * button never came from the catalog either: the catalog is fetched from the
 * panel and the panel can be down, while the subscription link arrives with the
 * card this screen was opened from. So with no catalog at all there is still a
 * working control that hands the link over — it is simply the concept's control
 * rather than an extra one bolted above it.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 *
 * A typeface. Concepts carry one, and shipping it would mean loading a webfont
 * per concept on a screen a customer sees once; the palette, the geometry and
 * the background travel, the letterforms stay the cabinet's.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarDays,
  ChevronsUpDown,
  CircleCheck,
  Copy,
  ExternalLink,
  Link2,
  Send,
  UserRound,
  ArrowUpDown,
} from 'lucide-react'
import { toast } from 'sonner'

import { getAllSubscriptions, getConnectPage } from '@/lib/api-client'
import { subscriptionQueryKeys } from '@/lib/subscription-query-keys'
import { useBranding } from '@/lib/branding-provider'
import { BackButton } from '@/components/ui/back-button'
import { BrandLogo } from '@/components/ui/brand-logo'
import { LoadErrorCard } from '@/components/ui/load-error-card'
import { formatDate, openExternalUrl } from '@/lib/utils'
import { subscriptionTitle } from '@/lib/subscription-title'
import type { Subscription } from '@/types/api'
import {
  buildDeepLink,
  chooseApp,
  line,
  readCatalog,
  type ConnectApp,
  type ConnectButton,
  type ConnectCatalog,
  type ConnectPlatform,
  type PlatformId,
} from './connect-catalog'
import { connectThemeStyle, readConnectTheme } from './connect-theme'
import { detectCurrentPlatform, rememberApp, rememberedApp } from './platform-detect'

export default function ConnectPage() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language.slice(0, 2)
  const { branding } = useBranding()

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

  // Read from the RAW payload rather than through `readCatalog`, which answers
  // null when there are no platforms. The appearance and the app list fail
  // independently: a catalog an operator emptied still leaves a screen with a
  // header, the facts and the link on it, and that screen should still be
  // wearing the concept they chose rather than reverting to the cabinet's.
  const theme = useMemo(
    () =>
      readConnectTheme(
        typeof catalogQuery.data === 'object' && catalogQuery.data !== null
          ? (catalogQuery.data as Record<string, unknown>)['theme']
          : undefined,
      ),
    [catalogQuery.data],
  )

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
  //
  // ── An id that was asked for and not found is NOT a fallback ────────────────
  //
  // The old reading fell through to "the first one with a url" in every case,
  // and while this screen showed nothing but buttons that was merely wrong about
  // the key. It now shows the name, the status, the expiry and the traffic — so
  // the same substitution turns into a confident statement about a subscription
  // the customer did not open, under a key that belongs to a different one. A
  // stale link, a subscription cancelled in another tab, an id from a session
  // that is no longer this account: every one of those lands here.
  //
  // So the fallback applies only when nothing was ASKED for. When an id was
  // asked for and the loaded list does not hold it, the screen says so.
  const resolved = useMemo(() => {
    const list = subscriptions.data?.subscriptions ?? []
    if (wantedId !== null) {
      const byId = list.find((s) => s.id === wantedId) ?? null
      // Still loading is not "not there": an empty list before the first answer
      // must not be reported as a subscription that does not exist.
      if (byId === null && subscriptions.data === undefined) return { subscription: null, missing: false }
      return { subscription: byId, missing: byId === null }
    }
    const any = list.find((s) => (s.url ?? '').length > 0) ?? list[0] ?? null
    return { subscription: any, missing: false }
  }, [subscriptions.data, wantedId])
  const subscription = resolved.subscription
  /** An id was handed over and the list does not hold it. */
  const subscriptionMissing = resolved.missing
  const subscriptionUrl = subscription?.url ?? ''

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

  // The concepts put a support control in the header, but the cabinet lets an
  // operator hide support entirely. Offering it here regardless would route a
  // customer to a screen their operator switched off.
  const supportVisible = (branding.navItems ?? []).some(
    (item) => item.id === 'support' && item.visible,
  )

  return (
    <div
      data-connect-theme={theme === null ? 'inherit' : 'concept'}
      className="relative min-h-[100dvh] pb-10"
      style={connectThemeStyle(theme)}
    >
      {theme?.rail != null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-1"
          style={{ background: theme.rail }}
        />
      )}

      {/* Two artboards, one arrangement. The desktop concept is the same
          vertical stack at 960 with 60px gutters, wider gaps and an app row
          instead of an app grid — so the breakpoints below are the only place
          the two differ, and neither is a separate layout to keep in step. */}
      <div className="relative mx-auto w-full max-w-[60rem] px-[18px] pt-5 md:px-[60px] md:pt-[30px]">
        <header className="flex h-10 items-center justify-between gap-3 md:h-12">
          <div className="flex min-w-0 items-center gap-[9px]">
            <BackButton fallback="/dashboard" label={t('common.back')} />
            {/* Decorative: the name is the text right beside it, and the mark
                carries that same string as its accessible title — so without
                this a screen reader reads the brand twice in a row. */}
            <span aria-hidden="true" className="contents">
              <BrandLogo className="size-[30px] shrink-0 rounded-[10px]" />
            </span>
            <span className="truncate text-base font-bold tracking-[0.06em]">
              {branding.brandName}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-[7px] md:gap-2">
            <RoundAction
              label={t('connect.copyLink')}
              disabled={subscriptionUrl.length === 0}
              onClick={() => void copyLink()}
            >
              <Link2 aria-hidden="true" className="size-[14px] md:size-4" />
            </RoundAction>
            {supportVisible && (
              <RoundAction label={t('connect.support')} href="/support">
                <Send aria-hidden="true" className="size-[14px] md:size-4" />
              </RoundAction>
            )}
          </div>
        </header>

        <div
          aria-hidden="true"
          className="mt-[18px] h-px bg-[color:var(--color-border-soft)] md:mt-[22px]"
        />

        {subscriptionMissing ? (
          <p
            data-testid="connect-subscription-missing"
            className={`${RAISED} mt-4 p-4 text-sm text-[color:var(--brand-muted-foreground)] md:mt-6`}
          >
            {t('connect.subscriptionMissing')}
          </p>
        ) : (
          <FactsGrid className="mt-4 md:mt-6" subscription={subscription} />
        )}

        <div className="mt-4 space-y-4 md:mt-[22px]">
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

          <Workspace>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-xl font-semibold md:text-[25px] md:tracking-[-0.4px]">
                  {t('connect.install')}
                </h2>
                {/* Desktop only, exactly as the artboards have it: the wider
                    header has room to say what the section wants, the phone one
                    does not and the steps say it anyway. */}
                <p className="hidden text-[11px] text-[color:var(--brand-muted-foreground)] md:block">
                  {t('connect.installHint')}
                </p>
              </div>
              {catalog !== null && platform !== null && (
                <PlatformPicker
                  platforms={catalog.platforms}
                  value={platform.id}
                  locale={locale}
                  label={t('connect.platform')}
                  markup={catalog.icons[platform.iconKey ?? '']}
                  onChange={(next) => {
                    setPlatformId(next)
                    setAppId(null)
                  }}
                />
              )}
            </div>

            {loading && (
              <p className="mt-[14px] text-sm text-[color:var(--brand-muted-foreground)]">
                {t('common.loading')}
              </p>
            )}

            {!loading && catalog === null && (
              <p className="mt-[14px] text-sm text-[color:var(--brand-muted-foreground)]">
                {t('connect.catalogUnavailable')}
              </p>
            )}

            {catalog !== null && platform !== null && (
              <>
                {platformGuessed && (
                  <p className="mt-[14px] text-xs text-[color:var(--brand-muted-foreground)]">
                    {t('connect.noSectionForDevice')}
                  </p>
                )}

                {platform.apps.length > 1 && (
                  <div
                    role="group"
                    data-testid="connect-apps"
                    aria-label={t('connect.appsForPlatform')}
                    className="mt-[14px] grid grid-cols-2 gap-[6px] md:mt-5 md:flex md:gap-2"
                  >
                    {platform.apps.map((candidate) => (
                      <AppTab
                        key={candidate.id}
                        app={candidate}
                        catalog={catalog}
                        selected={candidate.id === app?.id}
                        onSelect={() => selectApp(platform.id, candidate.id)}
                      />
                    ))}
                  </div>
                )}

                {app !== null && app.steps.length > 0 && (
                  <Timeline>
                    {app.steps.map((step, index) => (
                      <StepRow
                        key={`${app.id}-${index}`}
                        index={index}
                        last={index === app.steps.length - 1}
                        catalog={catalog}
                        locale={locale}
                        step={step}
                        subscriptionUrl={subscriptionUrl}
                        onCopy={copyLink}
                      />
                    ))}
                  </Timeline>
                )}
              </>
            )}
          </Workspace>
        </div>
      </div>
    </div>
  )
}

/**
 * The concept's raised surface: a soft card that sits over the background
 * rather than beside it.
 *
 * The blur and the two shadows are one look, not three decorations — the pale
 * one-pixel shadow at the top is what stops the card reading as a flat hole in
 * the gradient, and the concepts use it on every raised element.
 */
const RAISED =
  'rounded-[var(--radius-card)] border border-[color:var(--color-border-soft)] ' +
  'bg-[color:var(--color-surface-high)] backdrop-blur-[var(--glass-blur)] ' +
  'shadow-[0_14px_34px_rgba(0,0,0,0.33),0_1px_2px_rgba(255,255,255,0.19)]'

/** The sunken surface: chips, buttons, the timeline inside the workspace. */
const SUNKEN =
  'border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)]'

function Workspace({ children }: { children: React.ReactNode }) {
  return <section className={`${RAISED} p-4 md:p-6`}>{children}</section>
}

function Timeline({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="connect-timeline"
      className={`${SUNKEN} mt-3 rounded-[var(--radius-card)] px-3 backdrop-blur-[var(--glass-blur)] md:mt-[18px] md:px-[18px]`}
    >
      {children}
    </div>
  )
}

/** A header control, sized and shaped like the concept's round actions. */
function RoundAction({
  label,
  children,
  onClick,
  href,
  disabled,
}: {
  label: string
  children: React.ReactNode
  onClick?: () => void
  href?: string
  disabled?: boolean
}) {
  const className = `${SUNKEN} flex size-8 items-center justify-center rounded-full text-[color:var(--brand-primary)] disabled:opacity-40 md:size-9`
  if (href !== undefined) {
    return (
      <a href={href} aria-label={label} title={label} className={className}>
        {children}
      </a>
    )
  }
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={className}>
      {children}
    </button>
  )
}

/**
 * The four facts, in the concept's 2×2 block.
 *
 * They also appear on the card this screen was opened from, and that repetition
 * is deliberate: the screen is reached by a tap that leaves the card behind, and
 * a customer holding several subscriptions otherwise has nothing here telling
 * them WHICH one they are about to install. Naming it is the tiles' real job;
 * looking like the concept is the other one.
 */
function FactsGrid({
  subscription,
  className,
}: {
  subscription: Subscription | null
  className?: string
}) {
  const { t } = useTranslation()

  const status =
    subscription === null
      ? '—'
      : subscription.status === 'ACTIVE' || subscription.status === 'LIMITED'
        ? t('card.activeStatus')
        : subscription.status === 'EXPIRED'
          ? t('card.expiredStatus')
          : t('card.pendingStatus')

  const expiry = subscription?.expiresAt ?? subscription?.expireAt ?? null
  const used = subscription?.trafficUsed ?? null
  const limit = subscription?.trafficLimit ?? null
  // `used` is documented as null when usage data is UNAVAILABLE, which is not
  // zero. Coalescing it told a customer who may have spent most of their quota
  // that they had spent none — a definite claim, on a screen whose whole job is
  // to state facts about this subscription. An em dash says "not known", which
  // is the true answer and the one the dashboard card already gives.
  const cap = limit === null || limit <= 0 ? '∞' : String(limit)
  const traffic =
    used === null && limit === null
      ? '—'
      : `${used === null ? '—' : used} / ${cap} ${t('common.gb')}`

  return (
    <div data-testid="connect-facts" className={`grid grid-cols-2 gap-2 md:gap-2.5 ${className ?? ''}`.trim()}>
      {/* The Remnawave profile name, and the one tile that is allowed two
          lines. It is what the customer is being asked to recognise — the thing
          this screen is about to install and the name their VPN client will
          show them afterwards — so `rz_dizzable_sub` truncated to `rz_dizzab…`
          fails the tile's only job. The other three are short by nature and
          stay on one line.

          `subscriptionTitle` rather than a chain written out here: the select
          card, the delete dialog and the renewal page all name a subscription
          the same way, and a customer holding several sees them side by side. */}
      <Fact
        icon={<UserRound aria-hidden="true" className="size-3" />}
        label={t('connect.factName')}
        wrap
      >
        {subscription === null ? '—' : subscriptionTitle(subscription)}
      </Fact>
      <Fact icon={<CircleCheck aria-hidden="true" className="size-3" />} label={t('connect.factStatus')}>
        {status}
      </Fact>
      <Fact icon={<CalendarDays aria-hidden="true" className="size-3" />} label={t('connect.factExpires')}>
        {expiry === null ? '—' : formatDate(expiry)}
      </Fact>
      <Fact icon={<ArrowUpDown aria-hidden="true" className="size-3" />} label={t('connect.factTraffic')}>
        {traffic}
      </Fact>
    </div>
  )
}

function Fact({
  icon,
  label,
  children,
  wrap,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  /** Let a long value take a second line instead of losing its tail. */
  wrap?: boolean
}) {
  return (
    <div className={`${RAISED} flex flex-col gap-2 p-3`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--brand-muted-foreground)]">
          {label}
        </span>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--color-border-soft)] text-[color:var(--brand-primary)]">
          {icon}
        </span>
      </div>
      <span
        title={typeof children === 'string' ? children : undefined}
        className={
          wrap === true
            ? 'line-clamp-2 break-all text-sm font-semibold'
            : 'truncate text-sm font-semibold'
        }
      >
        {children}
      </span>
    </div>
  )
}

/**
 * One app in the 2×2 grid.
 *
 * The oversized, near-transparent copy of the app's own mark bleeding off the
 * right edge is the concepts' one piece of decoration, and it earns its place:
 * it is the only thing distinguishing four otherwise identical chips at a
 * glance.
 *
 * Every chip is the SAME shape. The artboards draw the selected one at a 5px
 * corner against 18px for the rest, and rendered at real size that reads as a
 * chip that failed to round rather than as a chip that is chosen — reported as
 * exactly that. Selection is the fill, and `aria-pressed` carries it for anyone
 * who cannot see the fill at all.
 */
function AppTab({
  app,
  catalog,
  selected,
  onSelect,
}: {
  app: ConnectApp
  catalog: ConnectCatalog
  selected: boolean
  onSelect: () => void
}) {
  const markup = catalog.icons[app.iconKey ?? '']
  return (
    <button
      type="button"
      data-connect-app={app.id}
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative flex h-9 min-w-0 items-center gap-[6px] overflow-hidden rounded-[var(--radius-pill)] border px-[7px] md:h-11 md:flex-1 md:gap-2 md:px-[11px] ${
        selected
          ? 'border-[color:var(--brand-primary)] bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]'
          : 'border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] text-[color:var(--brand-muted-foreground)]'
      }`}
    >
      {markup !== undefined && (
        // The etched copy of the mark bleeding off the right edge — the
        // concepts' one piece of decoration. `luminosity` is theirs too: it
        // drops the mark's own colour and keeps only its light, so a bright
        // brand does not glow through the chip it is sitting in.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-3 left-10 size-16 opacity-10 mix-blend-luminosity [&>svg]:size-16 md:-top-4 md:left-[122px] md:size-[86px] md:[&>svg]:size-[86px]"
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      )}
      {/* The mark sits on a plate, and the plate is not decoration. Most of
          these marks are a light glyph with no ground of their own — on a light
          concept an unbacked one is invisible, and on the accent-filled selected
          chip a white glyph on coral is barely better. The artboards draw the
          same plate: a rounded square with a faint white edge. */}
      <span
        aria-hidden="true"
        data-connect-app-mark=""
        className="relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-white/15 bg-black/80 text-[10px] font-bold text-white/70 md:size-6 md:rounded-[5px] md:text-xs"
      >
        {/* The one surface on this screen that does NOT follow the concept,
            and deliberately: it is the mark's own ground, not the screen's. The
            artboards use PNGs that carry their own background; these marks are
            light glyphs on transparent, so on a light concept an unbacked one
            is invisible and on the accent-filled selected chip it is worse. An
            app-icon plate is dark in every operating system for the same
            reason. Neutral black at a fixed alpha, no palette of its own.

            The letter is the artboards' own fallback — every mark in the file
            has a disabled letter layer sitting under it, because an operator
            adding an app nobody has a logo for is the ordinary case. A plate
            with an initial reads as deliberate; an empty plate reads as a
            failed image. */}
        <Icon markup={markup} className="size-4 md:size-5" fallback={app.name.slice(0, 1)} />
      </span>
      <span className="relative min-w-0 truncate text-xs font-semibold md:text-[13px]">
        {app.name}
      </span>
      {/* The operator's own "start here". It is data we already carry and the
          concepts mark it, so a catalog with a recommended app says so. */}
      {app.featured && (
        <span
          data-connect-featured=""
          aria-label="recommended"
          className={`relative ml-auto size-[5px] shrink-0 rounded-full ${
            selected
              ? 'bg-[color:var(--brand-primary-fg)]'
              : 'bg-[color:var(--brand-primary)]'
          }`}
        />
      )}
    </button>
  )
}

/** One numbered step in the timeline. */
function StepRow({
  step,
  index,
  last,
  catalog,
  locale,
  subscriptionUrl,
  onCopy,
}: {
  step: ConnectApp['steps'][number]
  index: number
  last: boolean
  catalog: ConnectCatalog
  locale: string
  subscriptionUrl: string
  onCopy: () => Promise<boolean>
}) {
  return (
    <>
      <div data-connect-step="" className="flex gap-[10px] py-[13px]">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] text-[color:var(--brand-primary)]">
          <Icon
            markup={catalog.icons[step.iconKey ?? '']}
            className="size-[14px]"
            fallback={<Link2 className="size-[14px]" />}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[7px]">
            {/* Ordinal, not decoration: these steps are a sequence and doing
                them out of order does not work. */}
            <span data-connect-step-number="" className="text-[10px] font-bold tabular-nums">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className="min-w-0 truncate text-sm font-semibold">{line(step.title, locale)}</h3>
          </div>
          {step.body !== null && (
            <p className="mt-1 text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {line(step.body, locale)}
            </p>
          )}
          {step.buttons.length > 0 && (
            <div className="mt-2 flex flex-col gap-[6px]">
              {step.buttons.map((btn, btnIndex) => (
                <StepButton
                  key={btnIndex}
                  button={btn}
                  locale={locale}
                  subscriptionUrl={subscriptionUrl}
                  onCopy={onCopy}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {!last && (
        <div
          aria-hidden="true"
          data-connect-step-rule=""
          className="h-px bg-[color:var(--color-border-soft)]"
        />
      )}
    </>
  )
}

const STEP_BUTTON =
  'flex w-full items-center justify-center gap-[6px] rounded-[var(--radius-pill)] px-[10px] py-2 text-xs font-semibold disabled:opacity-40'

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
      <button
        type="button"
        className={`${SUNKEN} ${STEP_BUTTON}`}
        onClick={() => void onCopy()}
        disabled={subscriptionUrl.length === 0}
      >
        <Copy aria-hidden="true" className="size-4" />
        {label}
      </button>
    )
  }

  if (button.kind === 'external') {
    return (
      <button type="button" className={`${SUNKEN} ${STEP_BUTTON}`} onClick={() => openExternalUrl(button.url)}>
        <ExternalLink aria-hidden="true" className="size-4 text-[color:var(--brand-primary)]" />
        {label}
      </button>
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
      className={`${STEP_BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
      onClick={() => window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium')}
    >
      <Link2 aria-hidden="true" className="size-4" />
      {label}
    </a>
  )
}

function PlatformPicker({
  platforms,
  value,
  locale,
  label,
  markup,
  onChange,
}: {
  platforms: readonly ConnectPlatform[]
  value: PlatformId
  locale: string
  label: string
  /** The platform's own mark, so the control says which device it is set to. */
  markup?: string
  onChange: (next: PlatformId) => void
}) {
  // Kept even though the platform is detected: detection reads a string the
  // browser chooses to send, and every "request desktop site" toggle exists to
  // make it lie. A wrong guess costs one tap; asking everyone costs it always.
  return (
    <label
      aria-label={label}
      className={`${SUNKEN} flex shrink-0 items-center gap-[6px] rounded-[var(--radius-pill)] px-[9px] py-2 md:gap-2 md:px-3 md:py-2.5`}
    >
      <span className="sr-only">{label}</span>
      <Icon markup={markup} className="size-[13px] text-[color:var(--brand-primary)] md:size-[15px]" />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as PlatformId)}
        className="appearance-none bg-transparent pr-1 text-xs font-medium outline-none"
      >
        {platforms.map((platform) => (
          <option key={platform.id} value={platform.id}>
            {line(platform.title, locale)}
          </option>
        ))}
      </select>
      <ChevronsUpDown aria-hidden="true" className="size-3 shrink-0 text-[color:var(--brand-primary)] md:size-3.5" />
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
function Icon({
  markup,
  fallback,
  className = 'size-5',
}: {
  markup?: string
  fallback?: React.ReactNode
  className?: string
}) {
  // Same test the catalog reader applied, on the value it stored — it now
  // trims there, so these two no longer disagree about a leading space.
  if (typeof markup !== 'string' || !markup.startsWith('<svg')) return <>{fallback ?? null}</>
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 ${className} [&>svg]:size-full`}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
