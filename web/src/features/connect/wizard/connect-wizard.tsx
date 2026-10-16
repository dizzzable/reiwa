/**
 * The guided connect walk — the «Интерактивный» mode of «Подключить».
 *
 * The page with every instruction (`connect-page.tsx`) lays the whole catalog
 * out at once, which suits a customer who knows what a VPN client is. This is
 * for everybody else: one question per screen, in the order the job is
 * actually done — which subscription, which device, which app, add the
 * subscription, switch it on — and then it WAITS until the VPN is seen online,
 * so "did it work?" is answered on the screen rather than in a support chat.
 *
 * The owner's decisions it is built to (16.10.2026, `interactive-connect-mode`):
 *
 *  - The look is inherited, never its own. The connect screen's concept when
 *    the operator chose one, the cabinet's otherwise; the face is the cabinet's
 *    («Брендинг»). Every colour and corner below is one of the cabinet's tokens.
 *  - The apps and their marks are the catalog's — the same catalog, read the
 *    same fail-closed way (`readCatalog`), so the two modes can never offer
 *    different apps. What each step means is read from its button kinds
 *    (`wizard-model.ts`), not from a new field the operator would have to fill.
 *  - With two or more subscriptions the walk ALWAYS starts by choosing one,
 *    even from a card's own «Подключить»: «так ему будет проще понять, какую он
 *    подключает». The cards are the home screen's own (`SubscriptionCard`), in
 *    the home screen's order, so each wears the look the operator gave its
 *    position.
 *
 * Detecting the connection is `connection-watch.ts`; where it cannot tell, the
 * customer is asked instead («Всё работает»), and the finish says which it was.
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Copy,
  CornerDownLeft,
  Crown,
  Download,
  Info,
  Layers,
  Link2,
  MessageCircle,
  MonitorSmartphone,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Timer,
  ToggleRight,
  Wifi,
} from 'lucide-react'
import { toast } from 'sonner'

import { getAllSubscriptions, getConnectPage, getSubscriptionDevices } from '@/lib/api-client'
import { subscriptionQueryKeys } from '@/lib/subscription-query-keys'
import { useBranding } from '@/lib/branding-provider'
import { useSafeBack } from '@/hooks/use-safe-back'
import { LoadErrorCard } from '@/components/ui/load-error-card'
import { useOperatorTimeZone } from '@/lib/operator-time-zone'
import { cn, formatDate, openExternalUrl } from '@/lib/utils'
import { isTelegramMiniAppSurface } from '@/lib/telegram-launch-params'
import { usePageBackdropStore } from '@/stores/page-backdrop.store'
import type { Subscription } from '@/types/api'
import { CONNECT_PAGE_QUERY_KEY } from '@/features/dashboard/connect-door'
import { SubscriptionCard } from '@/features/dashboard/components/subscription-card'
import { SubscriptionCarouselPagination } from '@/features/dashboard/components/subscription-carousel'

import {
  buildDeepLink,
  chooseApp,
  line,
  readCatalog,
  type ConnectApp,
  type ConnectCatalog,
  type ConnectPlatform,
  type PlatformId,
} from '../connect-catalog'
import { copyViaSelection } from '../clipboard'
import { trampolineUrl } from '../connect-trampoline'
import { deepLinkHandoff } from '../deep-link-handoff'
import { connectBackdrop, connectThemeStyle, readConnectTheme } from '../connect-theme'
import { ConnectLinkDialog } from '../connect-link-dialog'
import { detectCurrentPlatform, rememberApp, rememberedApp } from '../platform-detect'
import { useConnectionWatch } from './connection-watch'
import {
  canConnect,
  helpTopic,
  INITIAL_WALK,
  initialPlacement,
  initialPlatform,
  planApp,
  stepNumber,
  subscriptionReadiness,
  type AppPlan,
  type SubscriptionReadiness,
  type WizardStep,
  walkReducer,
} from './wizard-model'
import {
  ACCENT_SOFT,
  AppMark,
  BrandTile,
  CatalogIcon,
  CIRCLE,
  DrawnCheck,
  GHOST_BUTTON,
  HelpSheet,
  OUTLINE_BUTTON,
  PRIMARY_BUTTON,
  RAISED,
  Radar,
  SMALL_CORNER,
  SuccessBurst,
  SUNKEN,
  WizardHeader,
  type HelpTip,
} from './wizard-parts'
import './connect-wizard.css'

type Sheet = 'help' | 'link' | null
type Confirmation = 'signal' | 'customer'

/** How long «Включение» waits before it also offers «Всё работает» on a plain "not yet". */
const MANUAL_AFTER_MS = 15_000

/**
 * A short buzz on a phone, never on a page nobody has touched yet: Chrome
 * refuses `vibrate` before the first gesture and logs an error for it. In a
 * Mini App, Telegram's own haptics are the ones that work.
 */
function buzz(kind: 'select' | 'success'): void {
  const haptics = window.Telegram?.WebApp?.HapticFeedback
  if (haptics !== undefined) {
    if (kind === 'select') haptics.selectionChanged()
    else haptics.notificationOccurred('success')
    return
  }
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  if (typeof navigator.vibrate !== 'function' || activation?.hasBeenActive === false) return
  try {
    navigator.vibrate(kind === 'select' ? 8 : [12, 40, 18])
  } catch {
    // Not offered on this device; nothing to tell anybody.
  }
}

/** The cabinet scrolls its `<main>`, not the window — a new step starts at its top. */
function scrollShellToTop(): void {
  const main = document.querySelector('main')
  if (main !== null && typeof main.scrollTo === 'function') main.scrollTo({ top: 0 })
}

export default function ConnectWizard() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language.slice(0, 2)
  const navigate = useNavigate()
  const leave = useSafeBack('/dashboard')
  const reduced = useReducedMotion() === true
  const { branding, themeMode } = useBranding()
  const dateZone = useOperatorTimeZone()
  const [searchParams] = useSearchParams()
  const wantedId = searchParams.get('subscriptionId')

  const subscriptions = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 30_000,
  })
  const catalogQuery = useQuery({
    queryKey: CONNECT_PAGE_QUERY_KEY,
    queryFn: getConnectPage,
    staleTime: 60_000,
  })
  const catalog = useMemo(() => readCatalog(catalogQuery.data), [catalogQuery.data])
  const theme = useMemo(
    () =>
      readConnectTheme(
        typeof catalogQuery.data === 'object' && catalogQuery.data !== null
          ? (catalogQuery.data as Record<string, unknown>)['theme']
          : undefined,
      ),
    [catalogQuery.data],
  )
  const themeStyle = useMemo(() => ({ colorScheme: themeMode, ...connectThemeStyle(theme) }), [themeMode, theme])

  // The concept's ground goes to the shell, exactly as on the page with every
  // instruction (`connect-page.tsx`), and is cleared on the way out.
  const setBackdrop = usePageBackdropStore((state) => state.setBackdrop)
  const backdrop = useMemo(() => connectBackdrop(theme), [theme])
  useEffect(() => {
    setBackdrop(backdrop)
    return () => setBackdrop(null)
  }, [backdrop, setBackdrop])

  // The home screen's list, in the home screen's order: the card at index N
  // wears the look the operator gave position N.
  const rows: readonly Subscription[] = useMemo(
    () => subscriptions.data?.subscriptions ?? [],
    [subscriptions.data],
  )

  // Where the walk starts is DERIVED from the list (`initialPlacement`) rather
  // than copied into state when the list arrives: until the customer moves,
  // the walk simply stands where the list puts it, and every choice made after
  // that is state of its own.
  const placement = useMemo(
    () => (subscriptions.data === undefined ? null : initialPlacement(rows, wantedId)),
    [rows, subscriptions.data, wantedId],
  )
  const [walk, dispatch] = useReducer(walkReducer, INITIAL_WALK)
  const step: WizardStep | null = walk.step ?? placement?.step ?? null
  const direction = walk.direction

  const [focusPick, setFocusPick] = useState<number | null>(null)
  const focusIndex = focusPick ?? placement?.focus ?? 0
  const [chosenPick, setChosenPick] = useState<string | null>(null)
  const chosenId = chosenPick ?? placement?.chosenId ?? null
  const [platformPick, setPlatformPick] = useState<PlatformId | null>(null)
  const [appId, setAppId] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [connectedAt, setConnectedAt] = useState<Date | null>(null)
  /** The stay on «Подписка» during which the subscription was handed over. */
  const [handedOverVisit, setHandedOverVisit] = useState(-1)
  /** The stay on «Включение» that has waited long enough to offer «Всё работает». */
  const [manualVisit, setManualVisit] = useState(-1)
  const handedOver = step === 'add' && handedOverVisit === walk.visit
  const manualReady = step === 'enable' && manualVisit === walk.visit

  const detected = useMemo(() => detectCurrentPlatform(), [])
  // The device the customer picked, while the catalog still has it; otherwise
  // the one the walk detected. An operator removing a platform mid-walk lands
  // the customer back on the detected one instead of on nothing.
  const pickedPlatform = catalog?.platforms.find((candidate) => candidate.id === platformPick) ?? null
  const platform: ConnectPlatform | null =
    pickedPlatform ?? (catalog === null ? null : initialPlatform(catalog.platforms, detected))
  const platformPicked = pickedPlatform !== null
  const app: ConnectApp | null = useMemo(
    () => (platform === null ? null : chooseApp(platform, appId ?? rememberedApp(platform.id))),
    [platform, appId],
  )
  const plan: AppPlan | null = useMemo(() => (app === null ? null : planApp(app)), [app])

  const chosen = rows.find((row) => row.id === chosenId) ?? null
  const focused = rows[Math.min(focusIndex, Math.max(rows.length - 1, 0))] ?? null
  const subscriptionUrl = chosen?.url ?? ''

  // The device count for the card in front of the customer only — the same
  // query and key as the home screen's list, so it is usually cached already.
  const devicesFor = step === 'select' ? (focused?.id ?? null) : (chosen?.id ?? null)
  const devices = useQuery({
    queryKey: ['devices', devicesFor],
    queryFn: () => getSubscriptionDevices(devicesFor as string),
    enabled: devicesFor !== null,
    staleTime: 30_000,
  })
  const deviceCount =
    devices.data === undefined ? null : (devices.data.total ?? devices.data.devices?.length ?? null)

  // A new round per device: after «Подключить ещё устройство» the first device
  // is online and moves `onlineAt` by itself, so the old baseline would call
  // the second one connected at once. A fresh one reads it as busy instead.
  const [round, setRound] = useState(0)
  const watch = useConnectionWatch(
    step !== null && step !== 'select' ? chosenId : null,
    step === 'enable' ? walk.visit : null,
    round,
  )

  const handoff = useMemo(() => deepLinkHandoff({ insideTelegram: isTelegramMiniAppSurface() }), [])
  const supportVisible = (branding.navItems ?? []).some((item) => item.id === 'support' && item.visible)

  const go = (to: WizardStep): void => {
    if (step === null) return
    setSheet(null)
    dispatch({ type: 'go', from: step, to })
  }

  const back = (): void => {
    if (sheet !== null) {
      setSheet(null)
      return
    }
    if (walk.history.length === 0) {
      leave()
      return
    }
    dispatch({ type: 'back' })
  }

  const finish = (by: Confirmation): void => {
    setConfirmation(by)
    setConnectedAt(new Date())
    go('done')
  }

  useEffect(() => {
    if (step !== null) scrollShellToTop()
  }, [step])

  // Seen online: a moment for the radar to fold in, then the finish. A move
  // from «Включение» only — `walkReducer` drops it if the customer has gone
  // elsewhere in the meantime.
  useEffect(() => {
    if (step !== 'enable' || watch.verdict !== 'connected') return
    buzz('success')
    const timer = setTimeout(
      () => {
        setSheet(null)
        setConfirmation('signal')
        setConnectedAt(new Date())
        dispatch({ type: 'go', from: 'enable', to: 'done' })
      },
      reduced ? 400 : 1100,
    )
    return () => clearTimeout(timer)
  }, [reduced, step, watch.verdict])

  useEffect(() => {
    if (step !== 'enable') return
    const visit = walk.visit
    const timer = setTimeout(() => setManualVisit(visit), MANUAL_AFTER_MS)
    return () => clearTimeout(timer)
  }, [step, walk.visit])

  // Back from the VPN app after the subscription was handed over: that return
  // IS the "done" of this step, so the walk moves on by itself. The page has
  // to have actually been left first — a tap that opened nothing must not.
  useEffect(() => {
    if (!handedOver) return
    let left = document.visibilityState === 'hidden'
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        left = true
        return
      }
      if (!left) return
      toast.success(t('connectWizard.welcomeBack'))
      setSheet(null)
      dispatch({ type: 'go', from: 'add', to: 'enable' })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [handedOver, t])

  const copyLink = async (): Promise<boolean> => {
    if (subscriptionUrl.length === 0) {
      toast.error(t('connect.noLink'))
      return false
    }
    try {
      if (navigator.clipboard?.writeText !== undefined) await navigator.clipboard.writeText(subscriptionUrl)
      else if (!copyViaSelection(subscriptionUrl)) throw new Error('no clipboard')
    } catch {
      if (!copyViaSelection(subscriptionUrl)) {
        toast.error(t('connect.copyFailed'))
        return false
      }
    }
    toast.success(t('connect.copied'))
    buzz('success')
    return true
  }

  const deviceName = (id: PlatformId | null | undefined): string =>
    id === null || id === undefined ? '—' : t(`connectWizard.platform.${id}`)

  const stepLabel = (current: WizardStep): string => {
    const number = stepNumber(current)
    if (number === 0) return current === 'done' ? t('connectWizard.stepDone') : t('connectWizard.title')
    const name = {
      device: t('connectWizard.stepDevice'),
      app: t('connectWizard.stepApp'),
      add: t('connectWizard.stepAdd'),
      enable: t('connectWizard.stepEnable'),
    }[current as 'device' | 'app' | 'add' | 'enable']
    return t('connectWizard.stepOf', { n: number, name })
  }

  // ── The steps ──────────────────────────────────────────────────────────────

  function renderStep(current: WizardStep): ReactNode {
    // Narrowed above; restated for the closures below.
    const cat = catalog as ConnectCatalog
    const plat = platform as ConnectPlatform
    const currentApp = app as ConnectApp
    const currentPlan = plan as AppPlan
    const appName = currentApp.name

    switch (current) {
      case 'select': {
        const readiness = focused === null ? null : readinessOf(focused, deviceCount)
        const planName = focused === null ? '' : planTitle(focused, t('subscription.planFallback'))
        return (
          <div className="flex flex-col">
            <div className="pt-5">
              <h1 className="text-[28px] font-semibold leading-[1.12] tracking-[-0.02em] text-balance">
                {t('connectWizard.selectTitle')}
              </h1>
              <p className="mt-2 text-[15px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">
                {t('connectWizard.selectBody', { count: rows.length })}
              </p>
            </div>
            <SelectCarousel
              rows={rows}
              focus={focusIndex}
              reduced={reduced}
              onFocus={(index) => {
                setFocusPick(index)
                buzz('select')
              }}
              slideLabel={(index) => t('connectWizard.selectCardAria', { index: index + 1, count: rows.length })}
            />
            {focused !== null && readiness !== null && (
              <div className="mt-5 flex flex-col gap-4">
                <div className={`${SUNKEN} flex items-center gap-3 p-3.5`} data-wizard-select-info="">
                  <span
                    className={`${SMALL_CORNER} ${ACCENT_SOFT} grid size-[38px] shrink-0 place-items-center text-[color:var(--brand-primary)]`}
                  >
                    <MonitorSmartphone aria-hidden="true" className="size-[18px]" />
                  </span>
                  <div className="min-w-0">
                    <b className="block truncate text-sm font-semibold">
                      {deviceCount !== null && focused.deviceLimit !== null && focused.deviceLimit > 0
                        ? `${planName} · ${t('connectWizard.devicesUsage', { used: deviceCount, limit: focused.deviceLimit })}`
                        : planName}
                    </b>
                    <span className="mt-0.5 block text-[13px] leading-snug text-[color:var(--brand-muted-foreground)]">
                      {readinessText(readiness, planName, t)}
                    </span>
                  </div>
                </div>
                {readiness.kind === 'expired' ? (
                  <button type="button" className={PRIMARY_BUTTON} onClick={() => void navigate('/renew')}>
                    <RefreshCw aria-hidden="true" className="size-[18px]" />
                    {t('connectWizard.renew', { plan: planName })}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={PRIMARY_BUTTON}
                    disabled={!canConnect(readiness)}
                    data-wizard-pick=""
                    onClick={() => {
                      setChosenPick(focused.id)
                      go('start')
                    }}
                  >
                    {t('connectWizard.pick', { plan: planName })}
                    <ArrowRight aria-hidden="true" className="size-[18px]" />
                  </button>
                )}
                <p className="flex items-start gap-2 text-[12.5px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">
                  <Timer aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                  <span>{t('connectWizard.selectNote')}</span>
                </p>
              </div>
            )}
          </div>
        )
      }

      case 'start': {
        const sub = chosen
        const planName = sub === null ? '' : planTitle(sub, t('subscription.planFallback'))
        const end = sub?.expiresAt ?? sub?.expireAt ?? null
        const preview = [
          { icon: <Smartphone />, title: t('connectWizard.stepDevice'), body: t('connectWizard.previewDevice') },
          { icon: <Download />, title: t('connectWizard.stepApp'), body: t('connectWizard.previewApp') },
          { icon: <Link2 />, title: t('connectWizard.stepAdd'), body: t('connectWizard.previewAdd') },
          { icon: <Power />, title: t('connectWizard.stepEnable'), body: t('connectWizard.previewEnable') },
        ]
        return (
          <div className="flex flex-col gap-[22px] pt-5">
            {/* The card the customer picked, now a chip: it drops in from where
                the card was, so the choice visibly carries over. */}
            <motion.div
              initial={reduced ? false : { opacity: 0, y: 56, scale: 0.86 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 24, delay: 0.05 }}
              className={`${SUNKEN} flex h-[34px] max-w-full items-center gap-2 self-start pl-3 pr-1.5 text-[13px] font-medium text-[color:var(--brand-muted-foreground)]`}
              data-wizard-chip=""
            >
              <i aria-hidden="true" className={`cw-live size-[7px] shrink-0 ${CIRCLE} bg-[color:var(--brand-primary)]`} />
              <span className="min-w-0 truncate">
                {planName} ·{' '}
                {end === null
                  ? t('connectWizard.chipNoEnd')
                  : t('connectWizard.chipUntil', { date: formatDate(end, dateZone) })}
              </span>
              {rows.length > 1 && (
                <>
                  <i aria-hidden="true" className="h-3.5 w-px shrink-0 bg-[color:var(--color-border-strong)]" />
                  <button
                    type="button"
                    className={`${SMALL_CORNER} h-7 shrink-0 px-2 font-semibold text-[color:var(--brand-primary)]`}
                    onClick={() => {
                      setSheet(null)
                      dispatch({ type: 'restart', to: 'select', direction: -1 })
                    }}
                  >
                    {t('connectWizard.change')}
                  </button>
                </>
              )}
            </motion.div>
            <div className="flex flex-col gap-3.5 pt-0.5">
              <h1 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.02em] text-balance">
                {t('connectWizard.startTitle')}
              </h1>
              <p className="text-[15px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">
                {t('connectWizard.startBody')}
              </p>
            </div>
            <ol className={`${RAISED} m-0 list-none px-4 py-1`}>
              {preview.map((item, index) => (
                <motion.li
                  key={item.title}
                  initial={reduced ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.12 + index * 0.05, duration: 0.3 }}
                  className={cn(
                    'flex items-center gap-3.5 py-3',
                    index > 0 && 'border-t border-[color:var(--color-border-soft)]',
                  )}
                >
                  <span
                    className={cn(
                      `${SMALL_CORNER} grid size-9 shrink-0 place-items-center [&>svg]:size-[17px]`,
                      index === 0
                        ? `${ACCENT_SOFT} text-[color:var(--brand-primary)]`
                        : 'bg-[color:var(--color-surface)] text-[color:var(--brand-muted-foreground)]',
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <b className="block text-[15px] font-semibold">{item.title}</b>
                    <span className="block text-[13px] text-[color:var(--brand-muted-foreground)]">{item.body}</span>
                  </span>
                  <span className="font-mono text-xs text-[color:var(--brand-muted-foreground)]">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </motion.li>
              ))}
            </ol>
            <div className="flex flex-col gap-2">
              <button type="button" className={PRIMARY_BUTTON} onClick={() => go('device')} data-wizard-begin="">
                {t('connectWizard.begin')}
                <ArrowRight aria-hidden="true" className="size-[18px]" />
              </button>
              <button type="button" className={GHOST_BUTTON} onClick={() => go('add')}>
                {t('connectWizard.alreadyInstalled')}
              </button>
            </div>
            <p className="flex items-center justify-center gap-2 text-[12.5px] text-[color:var(--brand-muted-foreground)]">
              <Timer aria-hidden="true" className="size-3.5" />
              {t('connectWizard.startMeta')}
            </p>
          </div>
        )
      }

      case 'device': {
        const auto = !platformPicked && detected !== null && plat.id === detected
        const others = cat.platforms.filter((candidate) => candidate.id !== plat.id)
        return (
          <div className="flex flex-col gap-[22px] pt-5">
            <div>
              <h1 className="text-[28px] font-semibold leading-[1.12] tracking-[-0.02em] text-balance">
                {t('connectWizard.deviceTitle')}
              </h1>
              <p className="mt-2 text-[15px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">
                {platformPicked
                  ? t('connectWizard.deviceChosen')
                  : auto
                    ? t('connectWizard.deviceDetected')
                    : t('connectWizard.deviceUnknown')}
              </p>
            </div>
            <motion.div
              key={plat.id}
              initial={reduced ? false : { scale: 0.96, opacity: 0.55 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 22 }}
              className="flex flex-col gap-3.5 rounded-[var(--radius-card)] border-[1.5px] border-[color-mix(in_oklab,var(--brand-primary)_55%,transparent)] bg-[color:var(--color-surface-high)] p-[18px] shadow-[0_12px_36px_-10px_color-mix(in_oklab,var(--brand-primary)_34%,transparent)] backdrop-blur-[var(--glass-blur)]"
              data-wizard-device=""
            >
              <span
                className={`${SMALL_CORNER} ${ACCENT_SOFT} flex h-6 items-center gap-1.5 self-start px-2.5 text-xs font-medium text-[color:var(--brand-primary)]`}
              >
                <Sparkles aria-hidden="true" className="size-3" />
                {auto ? t('connectWizard.autoTag') : t('connectWizard.chosenTag')}
              </span>
              <div className="flex items-center gap-3.5">
                <span
                  className={`${SMALL_CORNER} ${ACCENT_SOFT} grid size-14 shrink-0 place-items-center text-[color:var(--brand-primary)]`}
                >
                  <CatalogIcon
                    markup={cat.icons[plat.iconKey ?? '']}
                    className="size-7"
                    fallback={<Smartphone aria-hidden="true" className="size-7" />}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <b className="block text-lg font-semibold">
                    {auto ? t('connectWizard.looksLike', { device: deviceName(plat.id) }) : deviceName(plat.id)}
                  </b>
                  <span className="mt-0.5 block text-[13px] text-[color:var(--brand-muted-foreground)]">
                    {line(plat.title, locale)} · {t('connectWizard.appsCount', { count: plat.apps.length })}
                  </span>
                </div>
                <span
                  className={`grid size-7 shrink-0 place-items-center ${CIRCLE} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
                >
                  <DrawnCheck className="size-4" />
                </span>
              </div>
            </motion.div>
            {others.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--brand-muted-foreground)]">
                  {t('connectWizard.otherDevice')}
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  {others.map((candidate, index) => (
                    <motion.button
                      key={candidate.id}
                      type="button"
                      initial={reduced ? false : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.12 + index * 0.04, duration: 0.3 }}
                      data-wizard-platform={candidate.id}
                      className={`${SUNKEN} flex h-[52px] min-w-0 items-center gap-2.5 px-3.5 text-left text-sm font-medium`}
                      onClick={() => {
                        setPlatformPick(candidate.id)
                        setAppId(null)
                        buzz('select')
                      }}
                    >
                      <span className="shrink-0 text-[color:var(--brand-muted-foreground)]">
                        <CatalogIcon
                          markup={cat.icons[candidate.iconKey ?? '']}
                          className="size-5"
                          fallback={<Smartphone aria-hidden="true" className="size-5" />}
                        />
                      </span>
                      <span className="truncate">{deviceName(candidate.id)}</span>
                    </motion.button>
                  ))}
                </div>
              </div>
            )}
            <div
              className={`${SUNKEN} flex items-center gap-3 p-3.5 text-[13px] leading-snug text-[color:var(--brand-muted-foreground)]`}
            >
              <QrCode aria-hidden="true" className="size-5 shrink-0" />
              <span>{t('connectWizard.qrHint')}</span>
            </div>
            <button type="button" className={PRIMARY_BUTTON} onClick={() => go('app')} data-wizard-device-ok="">
              {t('connectWizard.confirmDevice', { device: deviceName(plat.id) })}
              <ArrowRight aria-hidden="true" className="size-[18px]" />
            </button>
          </div>
        )
      }

      case 'app': {
        const alternatives = plat.apps.filter((candidate) => candidate.id !== currentApp.id)
        const subtitle = currentApp.featured
          ? currentPlan.addLink !== null
            ? t('connectWizard.appRecommendedOneTap', { device: deviceName(plat.id), app: appName })
            : t('connectWizard.appRecommended', { device: deviceName(plat.id), app: appName })
          : t('connectWizard.appChosen', { app: appName })
        return (
          <div className="flex flex-col gap-[22px] pt-5">
            <div>
              <h1 className="text-[28px] font-semibold leading-[1.12] tracking-[-0.02em] text-balance">
                {t('connectWizard.appTitle')}
              </h1>
              <p className="mt-2 text-[15px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">{subtitle}</p>
            </div>
            <motion.div
              key={currentApp.id}
              initial={reduced ? false : { scale: 0.96, opacity: 0.55 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 22 }}
              className={`${RAISED} flex flex-col gap-4 border-[color:var(--color-border-strong)] p-[18px]`}
              data-wizard-app={currentApp.id}
            >
              <div className="flex items-center gap-3.5">
                <AppMark markup={cat.icons[currentApp.iconKey ?? '']} name={appName} size={64} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="text-xl font-semibold">{appName}</b>
                    {currentApp.featured && (
                      <span
                        className={`${SMALL_CORNER} inline-flex h-[22px] items-center gap-1 px-2 text-[11px] font-semibold`}
                        style={{
                          color: cat.featuredColor,
                          background: `color-mix(in oklab, ${cat.featuredColor} 14%, transparent)`,
                        }}
                      >
                        <Star aria-hidden="true" className="size-[11px]" />
                        {t('connectWizard.featured')}
                      </span>
                    )}
                  </div>
                  {currentPlan.downloads.length > 0 && (
                    <p className="mt-1 truncate text-[13px] text-[color:var(--brand-muted-foreground)]">
                      {currentPlan.downloads.map((button) => line(button.label, locale)).join(' · ')}
                    </p>
                  )}
                </div>
              </div>
              {currentPlan.downloads.length === 0 ? (
                <p className="text-[13px] text-[color:var(--brand-muted-foreground)]">
                  {t('connectWizard.noDownloads', { app: appName })}
                </p>
              ) : (
                currentPlan.downloads.map((button, index) => (
                  <button
                    key={button.url}
                    type="button"
                    data-wizard-download=""
                    onClick={() => openExternalUrl(button.url)}
                    className={cn(
                      'flex min-h-[50px] w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 text-[15px] font-semibold',
                      index === 0
                        ? 'bg-[color:var(--brand-foreground)] text-[color:var(--color-surface)]'
                        : 'border border-[color:var(--color-border-strong)]',
                    )}
                  >
                    <Download aria-hidden="true" className="size-4" />
                    <span className="min-w-0 truncate">{line(button.label, locale)}</span>
                    <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
                  </button>
                ))
              )}
              <p className="flex items-start gap-2.5 border-t border-[color:var(--color-border-soft)] pt-3 text-[13px] leading-snug text-[color:var(--brand-muted-foreground)]">
                <CornerDownLeft aria-hidden="true" className="mt-px size-[15px] shrink-0 text-[color:var(--brand-primary)]" />
                {t('connectWizard.returnHint')}
              </p>
            </motion.div>
            {alternatives.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--brand-muted-foreground)]">
                  {t('connectWizard.otherApps')}
                </p>
                <div className="grid grid-cols-3 gap-2.5">
                  {alternatives.map((candidate, index) => (
                    <motion.button
                      key={candidate.id}
                      type="button"
                      initial={reduced ? false : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 + index * 0.04, duration: 0.3 }}
                      data-wizard-alt={candidate.id}
                      className={`${SUNKEN} flex min-w-0 flex-col items-center gap-2 px-1.5 py-3.5 text-[13px] font-medium`}
                      onClick={() => {
                        setAppId(candidate.id)
                        rememberApp(plat.id, candidate.id)
                        buzz('select')
                      }}
                    >
                      <AppMark markup={cat.icons[candidate.iconKey ?? '']} name={candidate.name} size={40} />
                      <span className="max-w-full truncate">{candidate.name}</span>
                    </motion.button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              className={PRIMARY_BUTTON}
              data-wizard-installed=""
              onClick={() => {
                rememberApp(plat.id, currentApp.id)
                go('add')
              }}
            >
              {t('connectWizard.installed', { app: appName })}
              <ArrowRight aria-hidden="true" className="size-[18px]" />
            </button>
          </div>
        )
      }

      case 'add': {
        const href = currentPlan.addLink === null ? null : buildDeepLink(currentPlan.addLink, subscriptionUrl)
        const signature = chosen?.connectSignature ?? null
        // One tap only when the host can actually pass the scheme on: inside
        // Telegram that needs the trampoline and its signature
        // (`deep-link-handoff.ts`); without one, copying is the honest button.
        const oneTap = href !== null && (handoff === 'anchor' || signature !== null)
        const steps = oneTap
          ? [
              t('connectWizard.nextOneTap1', { app: appName }),
              t('connectWizard.nextOneTap2', { app: appName }),
              t('connectWizard.nextOneTap3'),
            ]
          : [t('connectWizard.nextCopy1'), t('connectWizard.nextCopy2', { app: appName }), t('connectWizard.nextCopy3')]
        const operatorWords = currentPlan.addStep?.body ?? null
        return (
          <div className="flex flex-col gap-[22px] pt-5">
            <div>
              <h1 className="text-[28px] font-semibold leading-[1.12] tracking-[-0.02em] text-balance">
                {t('connectWizard.addTitle', { app: appName })}
              </h1>
              <p className="mt-2 text-[15px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">
                {oneTap
                  ? t('connectWizard.addBodyOneTap', { app: appName })
                  : operatorWords !== null
                    ? line(operatorWords, locale)
                    : t('connectWizard.addBodyCopy', { app: appName })}
              </p>
            </div>
            <div
              aria-hidden="true"
              className={`${RAISED} relative flex h-[150px] items-center justify-center gap-3 overflow-hidden`}
            >
              <span className="absolute inset-0 bg-[radial-gradient(50%_70%_at_50%_50%,color-mix(in_oklab,var(--brand-primary)_14%,transparent),transparent_70%)]" />
              <span className="relative flex flex-col items-center gap-2 text-xs text-[color:var(--brand-muted-foreground)]">
                <BrandTile size={56} />
                <span className="max-w-[88px] truncate">{branding.brandName}</span>
              </span>
              <span className="relative mb-[22px] h-14 w-28">
                <span className="absolute left-1 right-1 top-[27px] border-t-2 border-dotted border-[color:var(--color-border-strong)]" />
                <i className={`cw-packet absolute left-0 top-[22px] size-3 ${CIRCLE} bg-[color:var(--brand-primary)]`} />
                <span
                  className={`absolute left-[42px] top-3.5 grid size-7 place-items-center ${SMALL_CORNER} border border-[color:var(--color-border-strong)] bg-[color:var(--color-surface-high)]`}
                >
                  <Link2 className="size-3.5" />
                </span>
              </span>
              <span className="relative flex flex-col items-center gap-2 text-xs text-[color:var(--brand-muted-foreground)]">
                <AppMark markup={cat.icons[currentApp.iconKey ?? '']} name={appName} size={56} />
                <span className="max-w-[88px] truncate">{appName}</span>
              </span>
            </div>
            {subscriptionUrl.length === 0 ? (
              <p className={`${SUNKEN} p-3.5 text-[13px] text-[color:var(--brand-muted-foreground)]`}>
                {t('connectWizard.noLink')}
              </p>
            ) : oneTap && handoff === 'anchor' ? (
              // A real anchor: the host's own link handling is what passes the
              // scheme to the system (`connect-page.tsx`, `StepButton`).
              <a
                href={href as string}
                data-wizard-add=""
                className={`${PRIMARY_BUTTON} cw-shimmer min-h-[62px] text-[17px]`}
                onClick={() => {
                  setHandedOverVisit(walk.visit)
                  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium')
                }}
              >
                <Plus aria-hidden="true" className="size-[18px]" />
                {t('connectWizard.addButton', { app: appName })}
              </a>
            ) : oneTap ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  data-wizard-add=""
                  data-connect-trampoline=""
                  className={`${PRIMARY_BUTTON} cw-shimmer min-h-[62px] text-[17px]`}
                  onClick={() => {
                    setHandedOverVisit(walk.visit)
                    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium')
                    openExternalUrl(
                      trampolineUrl(window.location.origin, {
                        link: href as string,
                        subscriptionUrl,
                        signature: signature as string,
                      }),
                    )
                  }}
                >
                  <Plus aria-hidden="true" className="size-[18px]" />
                  {t('connectWizard.addButton', { app: appName })}
                </button>
                <p className="text-center text-[11px] leading-relaxed text-[color:var(--brand-muted-foreground)]">
                  {t('connect.openHint')}
                </p>
              </div>
            ) : (
              <button
                type="button"
                data-wizard-copy=""
                className={`${PRIMARY_BUTTON} cw-shimmer min-h-[62px] text-[17px]`}
                onClick={() => {
                  void copyLink().then((copied) => {
                    if (copied) setHandedOverVisit(walk.visit)
                  })
                }}
              >
                <Copy aria-hidden="true" className="size-[18px]" />
                {t('connectWizard.copyButton')}
              </button>
            )}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--brand-muted-foreground)]">
                {t('connectWizard.nextTitle')}
              </p>
              <ol className="m-0 mt-3.5 flex list-none flex-col gap-3 px-1">
                {steps.map((text, index) => (
                  <li key={text} className="flex items-center gap-3 text-sm">
                    <i
                      aria-hidden="true"
                      className={`grid size-[22px] shrink-0 place-items-center ${CIRCLE} border border-[color:var(--color-border-strong)] font-mono text-[11px] font-semibold not-italic text-[color:var(--brand-muted-foreground)]`}
                    >
                      {index + 1}
                    </i>
                    {text}
                  </li>
                ))}
              </ol>
            </div>
            {subscriptionUrl.length > 0 && (
              <div className={`${SUNKEN} flex flex-col gap-3 p-3.5`}>
                <p className="flex items-center gap-2 text-sm">
                  <Info aria-hidden="true" className="size-[15px] text-[color:var(--brand-muted-foreground)]" />
                  <b className="font-semibold">
                    {oneTap ? t('connectWizard.fallbackOneTap', { app: appName }) : t('connectWizard.fallbackOther')}
                  </b>
                </p>
                <div className="flex gap-2">
                  {oneTap && (
                    <button
                      type="button"
                      className={`${SMALL_CORNER} flex h-[42px] flex-1 items-center justify-center gap-1.5 bg-[color:var(--color-surface-high)] text-[13px] font-medium`}
                      onClick={() => {
                        void copyLink().then((copied) => {
                          if (copied) setHandedOverVisit(walk.visit)
                        })
                      }}
                    >
                      <Copy aria-hidden="true" className="size-3.5" />
                      {t('connectWizard.copyButton')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${SMALL_CORNER} flex h-[42px] flex-1 items-center justify-center gap-1.5 bg-[color:var(--color-surface-high)] text-[13px] font-medium`}
                    onClick={() => setSheet('link')}
                  >
                    <QrCode aria-hidden="true" className="size-3.5" />
                    {t('connectWizard.showQr')}
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <button type="button" className={OUTLINE_BUTTON} onClick={() => go('enable')} data-wizard-added="">
                {t('connectWizard.added')}
                <ArrowRight aria-hidden="true" className="size-4" />
              </button>
              <button type="button" className={GHOST_BUTTON} onClick={() => go('app')}>
                {t('connectWizard.changeApp')}
              </button>
            </div>
          </div>
        )
      }

      case 'enable': {
        const found = watch.verdict === 'connected'
        const operatorWords = currentPlan.enableStep?.body ?? null
        const manual = watch.verdict === 'busy' || watch.verdict === 'unknown' || manualReady || watch.gaveUp
        const [statusTitle, statusBody] = found
          ? [t('connectWizard.found'), t('connectWizard.foundSub')]
          : watch.verdict === 'busy'
            ? [t('connectWizard.busy'), t('connectWizard.busySub')]
            : watch.verdict === 'unknown'
              ? [t('connectWizard.unknown'), t('connectWizard.unknownSub', { app: appName })]
              : watch.gaveUp || manualReady
                ? [t('connectWizard.slow'), t('connectWizard.slowSub')]
                : [
                    t('connectWizard.waiting'),
                    watch.polls > 0 ? t('connectWizard.checkedNotYet') : t('connectWizard.waitingSub'),
                  ]
        const waitingLive = !found && watch.verdict === 'waiting' && !watch.gaveUp
        return (
          <div className="flex flex-col gap-[22px] pt-5">
            <div>
              <h1 className="text-[28px] font-semibold leading-[1.12] tracking-[-0.02em] text-balance">
                {t('connectWizard.enableTitle', { app: appName })}
              </h1>
              <p className="mt-2 text-[15px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">
                {operatorWords !== null
                  ? line(operatorWords, locale)
                  : watch.verdict === 'waiting'
                    ? t('connectWizard.enableBody', { app: appName })
                    : t('connectWizard.enableBodyManual', { app: appName })}
              </p>
            </div>
            <Radar found={found} />
            <div className="-mt-2 flex flex-col items-center gap-1.5 text-center" role="status" aria-live="polite">
              <p className="flex items-center gap-2 text-base font-semibold" data-wizard-status={watch.verdict}>
                {waitingLive && (
                  <i aria-hidden="true" className={`cw-live size-2 ${CIRCLE} bg-[color:var(--brand-primary)]`} />
                )}
                {statusTitle}
              </p>
              <span className="text-[13px] text-[color:var(--brand-muted-foreground)]">{statusBody}</span>
            </div>
            <div className={`${SUNKEN} flex items-start gap-3 p-3.5`}>
              <span
                className={`${SMALL_CORNER} grid size-8 shrink-0 place-items-center`}
                style={{
                  color: cat.featuredColor,
                  background: `color-mix(in oklab, ${cat.featuredColor} 14%, transparent)`,
                }}
              >
                <ShieldCheck aria-hidden="true" className="size-4" />
              </span>
              <div>
                <b className="block text-sm font-semibold">{t(`connectWizard.permission.${plat.id}.title`)}</b>
                <span className="mt-0.5 block text-[13px] leading-snug text-[color:var(--brand-muted-foreground)]">
                  {t(`connectWizard.permission.${plat.id}.body`)}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              {manual && !found && (
                <motion.button
                  type="button"
                  initial={reduced ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={PRIMARY_BUTTON}
                  data-wizard-it-works=""
                  onClick={() => finish('customer')}
                >
                  <Wifi aria-hidden="true" className="size-[18px]" />
                  {t('connectWizard.itWorks')}
                </motion.button>
              )}
              <button type="button" className={GHOST_BUTTON} onClick={() => setSheet('help')}>
                {t('connectWizard.cantConnect')}
              </button>
            </div>
          </div>
        )
      }

      case 'done': {
        const sub = chosen
        const time =
          connectedAt === null
            ? '—'
            : new Intl.DateTimeFormat(locale, {
                hour: '2-digit',
                minute: '2-digit',
                ...(dateZone === undefined ? {} : { timeZone: dateZone }),
              }).format(connectedAt)
        const rowsShown = [
          {
            icon: <Crown />,
            key: t('connectWizard.detailSubscription'),
            value: sub === null ? '—' : planTitle(sub, t('subscription.planFallback')),
          },
          { icon: <Smartphone />, key: t('connectWizard.detailDevice'), value: `${deviceName(plat.id)} · ${appName}` },
          {
            icon: <CalendarClock />,
            key: t('connectWizard.detailConnected'),
            value: t('connectWizard.detailConnectedValue', { time }),
          },
          {
            icon: <Layers />,
            key: t('connectWizard.detailCheck'),
            value:
              confirmation === 'signal'
                ? t('connectWizard.detailCheckSignal')
                : t('connectWizard.detailCheckCustomer'),
          },
        ]
        return (
          <div className="flex flex-col items-center gap-[22px] pt-10">
            <SuccessBurst reduced={reduced} />
            <motion.div
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.28, duration: 0.45 }}
              className="text-center"
            >
              <h1 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.02em] text-balance">
                {t('connectWizard.doneTitle')}
              </h1>
              <p className="mt-2 text-[15px] leading-[1.45] text-[color:var(--brand-muted-foreground)]">
                {t('connectWizard.doneBody', { app: appName })}
              </p>
            </motion.div>
            <motion.div
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.36, duration: 0.45 }}
              className={`${RAISED} w-full px-4 py-1`}
              data-wizard-details=""
            >
              {rowsShown.map((row, index) => (
                <div
                  key={row.key}
                  className={cn(
                    'flex items-center gap-2.5 py-3 text-sm',
                    index > 0 && 'border-t border-[color:var(--color-border-soft)]',
                  )}
                >
                  <span className="shrink-0 text-[color:var(--brand-muted-foreground)] [&>svg]:size-[15px]">
                    {row.icon}
                  </span>
                  <span className="flex-1 text-[color:var(--brand-muted-foreground)]">{row.key}</span>
                  <span className="min-w-0 truncate text-right font-medium">{row.value}</span>
                </div>
              ))}
            </motion.div>
            <motion.div
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.44, duration: 0.45 }}
              className="flex w-full flex-col gap-2"
            >
              <button type="button" className={PRIMARY_BUTTON} onClick={() => void navigate('/dashboard')}>
                {t('connectWizard.home')}
              </button>
              <button
                type="button"
                className={OUTLINE_BUTTON}
                onClick={() => {
                  setPlatformPick(null)
                  setAppId(null)
                  setRound((value) => value + 1)
                  setConfirmation(null)
                  setConnectedAt(null)
                  dispatch({ type: 'restart', to: 'device', direction: 1 })
                }}
              >
                <Plus aria-hidden="true" className="size-4" />
                {t('connectWizard.another')}
              </button>
            </motion.div>
          </div>
        )
      }
    }
  }

  // ── Not walkable yet ───────────────────────────────────────────────────────

  let body: ReactNode
  if (subscriptions.isError && subscriptions.data === undefined) {
    body = (
      <div className="pt-6">
        <LoadErrorCard
          title={t('connect.linkFailedTitle')}
          body={t('connectWizard.loadFailed')}
          retryLabel={t('common.retry')}
          pending={subscriptions.isFetching}
          onRetry={() => void subscriptions.refetch()}
        />
      </div>
    )
  } else if (subscriptions.data !== undefined && rows.length === 0) {
    body = (
      <div className={`${RAISED} mt-6 flex flex-col gap-4 p-5`}>
        <p className="text-[15px] text-[color:var(--brand-muted-foreground)]">{t('connectWizard.empty')}</p>
        <button type="button" className={PRIMARY_BUTTON} onClick={() => void navigate('/plans')}>
          {t('connectWizard.emptyAction')}
        </button>
      </div>
    )
  } else if (step === null || catalog === null || platform === null || app === null || plan === null) {
    body = (
      <p className="pt-8 text-center text-sm text-[color:var(--brand-muted-foreground)]" aria-busy="true">
        {t('connectWizard.loading')}
      </p>
    )
  } else {
    body = (
      <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.section
          key={step}
          data-wizard-step={step}
          custom={direction}
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 * direction }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, x: -24 * direction }}
          transition={{ duration: reduced ? 0.15 : 0.28, ease: [0.2, 0.9, 0.3, 1] }}
          className="pb-8"
        >
          {renderStep(step)}
        </motion.section>
      </AnimatePresence>
    )
  }

  const topic = step === null ? 'Select' : helpTopic(step)
  const helpAppName = app?.name ?? ''
  const helpTips: HelpTip[] =
    step === null
      ? []
      : [1, 2, 3].map((index) => {
          const titleKey = `connectWizard.tip${topic}${index}Title`
          const bodyKey = `connectWizard.tip${topic}${index}Body`
          // The permission tip is the platform's own, the same words «Включение» shows.
          const body =
            topic === 'Enable' && index === 2 && platform !== null
              ? t(`connectWizard.permission.${platform.id}.body`)
              : t(bodyKey, { app: helpAppName })
          return { title: t(titleKey, { app: helpAppName }), body, icon: TIP_ICONS[topic][index - 1] }
        })
  // What the customer has actually chosen so far, and nothing they have not:
  // the device from its own step on, the app from its. A guess shown here
  // before it was confirmed would read as a choice they never made.
  const numbered = step === null ? 0 : step === 'done' ? 5 : stepNumber(step)
  const contextSubscription = chosen ?? (step === 'select' ? focused : null)
  const helpContext = [
    contextSubscription === null ? null : planTitle(contextSubscription, t('subscription.planFallback')),
    platform === null || numbered < 1 ? null : deviceName(platform.id),
    app === null || numbered < 2 ? null : app.name,
    step === null ? null : stepLabel(step),
  ].filter((chip): chip is string => chip !== null && chip.length > 0)

  return (
    <div
      data-connect-theme={theme === null ? 'inherit' : 'concept'}
      data-connect-mode="interactive"
      className="relative min-h-[100dvh] overflow-x-clip"
      style={themeStyle}
    >
      <div
        aria-hidden="true"
        className={cn(
          'cw-aurora pointer-events-none absolute -left-1/4 -right-1/4 -top-[18%] h-[62%]',
          step === 'done' ? 'opacity-80' : step === 'start' ? 'opacity-55' : 'opacity-30',
        )}
      />
      <div className="relative mx-auto w-full max-w-[30rem] px-5 pt-4">
        <WizardHeader
          label={step === null ? t('connectWizard.title') : stepLabel(step)}
          filled={step === null ? 0 : stepNumber(step)}
          showProgress={step !== null && stepNumber(step) > 0}
          backLabel={t('connectWizard.back')}
          helpLabel={t('connectWizard.help')}
          onBack={back}
          onHelp={() => setSheet('help')}
        />
        {body}
      </div>

      <HelpSheet
        open={sheet === 'help'}
        title={t('connectWizard.helpTitle')}
        context={helpContext}
        tips={helpTips}
        themeStyle={themeStyle}
        closeLabel={t('connectWizard.helpClose')}
        reduced={reduced}
        onClose={() => setSheet(null)}
      >
        <div className="flex flex-col gap-2">
          {supportVisible && (
            <button type="button" className={PRIMARY_BUTTON} onClick={() => void navigate('/support')}>
              <MessageCircle aria-hidden="true" className="size-[18px]" />
              {t('connectWizard.helpSupport')}
            </button>
          )}
          <button
            type="button"
            className={OUTLINE_BUTTON}
            onClick={() => {
              const id = chosen?.id ?? focused?.id ?? null
              void navigate(
                id === null
                  ? '/subscription/connect?view=page'
                  : `/subscription/connect?subscriptionId=${encodeURIComponent(id)}&view=page`,
              )
            }}
          >
            {t('connectWizard.helpFullGuide')}
          </button>
        </div>
      </HelpSheet>

      {sheet === 'link' && subscriptionUrl.length > 0 && (
        <ConnectLinkDialog
          url={subscriptionUrl}
          surface={{ raised: RAISED, sunken: SUNKEN }}
          buttonClassName={PRIMARY_BUTTON}
          themeStyle={themeStyle}
          onCopy={copyLink}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  )
}

const TIP_ICONS: Readonly<Record<ReturnType<typeof helpTopic>, readonly ReactNode[]>> = {
  Select: [<Crown key="a" />, <RefreshCw key="b" />, <Layers key="c" />],
  Device: [<Smartphone key="a" />, <MonitorSmartphone key="b" />, <Info key="c" />],
  App: [<Download key="a" />, <ShieldCheck key="b" />, <RefreshCw key="c" />],
  Add: [<Link2 key="a" />, <ToggleRight key="b" />, <QrCode key="c" />],
  Enable: [<ToggleRight key="a" />, <ShieldCheck key="b" />, <RefreshCw key="c" />],
  Done: [<Wifi key="a" />, <Plus key="b" />, <RefreshCw key="c" />],
}

/** A subscription's readiness, with the device count when it is known. */
function readinessOf(subscription: Subscription, used: number | null): SubscriptionReadiness {
  return subscriptionReadiness({
    status: subscription.status,
    hasLink: (subscription.url ?? '').length > 0,
    used,
    limit: subscription.deviceLimit,
  })
}

/** The plan's name as the card prints it. */
function planTitle(subscription: Subscription, fallback: string): string {
  return subscription.plan?.name ?? fallback
}

function readinessText(readiness: SubscriptionReadiness, plan: string, t: TFunction): string {
  switch (readiness.kind) {
    case 'expired':
      return t('connectWizard.infoExpired')
    case 'pending':
      return t('connectWizard.infoPending')
    case 'full':
      return t('connectWizard.infoFull')
    case 'first':
      return t('connectWizard.infoFirst')
    case 'free':
      return t('connectWizard.infoFree', { free: readiness.free })
    case 'plain':
      return t('connectWizard.infoPlain', { plan })
  }
}

/**
 * The home screen's cards, side by side, swiped the same way.
 *
 * Its own small carousel rather than the home screen's: that one also carries
 * cards being bought and cards being deleted, a long press and a double tap,
 * none of which belong in a question with one answer. What it shares is what
 * the customer recognises — the card itself, its position's look, the dots.
 */
function SelectCarousel({
  rows,
  focus,
  reduced,
  onFocus,
  slideLabel,
}: {
  rows: readonly Subscription[]
  focus: number
  reduced: boolean
  onFocus: (index: number) => void
  slideLabel: (index: number) => string
}) {
  const track = useRef<HTMLDivElement | null>(null)
  const frame = useRef(0)
  const focusRef = useRef(focus)
  useEffect(() => {
    focusRef.current = focus
  }, [focus])

  const offsetFor = (index: number): number | null => {
    const element = track.current
    const slide = element?.children[index] as HTMLElement | undefined
    if (element === null || slide === undefined) return null
    return slide.offsetLeft - (element.clientWidth - slide.clientWidth) / 2
  }

  // Opens ON the card the customer came from, without a visible scroll.
  useLayoutEffect(() => {
    const left = offsetFor(focusRef.current)
    if (track.current !== null && left !== null) track.current.scrollLeft = left
  }, [])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const scrollTo = (index: number): void => {
    const left = offsetFor(index)
    if (track.current === null || left === null) return
    track.current.scrollTo({ left, behavior: reduced ? 'auto' : 'smooth' })
  }

  const onScroll = (): void => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const element = track.current
      if (element === null) return
      const middle = element.scrollLeft + element.clientWidth / 2
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      Array.from(element.children).forEach((child, index) => {
        const slide = child as HTMLElement
        const distance = Math.abs(slide.offsetLeft + slide.clientWidth / 2 - middle)
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      })
      if (best !== focusRef.current) onFocus(best)
    })
  }

  return (
    <div className="-mx-5 mt-2">
      <div
        ref={track}
        onScroll={onScroll}
        data-wizard-carousel=""
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-8 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {rows.map((row, index) => (
          <motion.div
            key={row.id}
            role="group"
            aria-roledescription="slide"
            aria-label={slideLabel(index)}
            aria-current={index === focus ? 'true' : undefined}
            data-wizard-slide={row.id}
            className="w-[calc(100%-4rem)] shrink-0 snap-center"
            animate={reduced ? { opacity: index === focus ? 1 : 0.6 } : { scale: index === focus ? 1 : 0.94, opacity: index === focus ? 1 : 0.55 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            onClick={() => {
              if (index !== focus) scrollTo(index)
            }}
          >
            <SubscriptionCard
              subscription={row}
              index={index}
              effectActive={index === focus}
              effectWarm={Math.abs(index - focus) === 1}
            />
          </motion.div>
        ))}
      </div>
      <SubscriptionCarouselPagination
        count={rows.length}
        activeIndex={focus}
        disabled={false}
        onSelect={scrollTo}
        getLabel={slideLabel}
      />
    </div>
  )
}
