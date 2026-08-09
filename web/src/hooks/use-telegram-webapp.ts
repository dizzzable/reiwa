import { useEffect, useRef, useState } from 'react'
import { reportClientError } from '@/lib/client-error-reporter'
import { hasTelegramLaunchParameters } from '@/lib/telegram-launch-params'
// The SDK surface and the `window.Telegram` / `__reiwaTelegramSdkState`
// globals live in `@/types/telegram` and are declared exactly once. This hook
// used to carry its own copy alongside a second one in `vite-env.d.ts`;
// `skipLibCheck` hid the conflict, so add members there, never here.
import type { TelegramUser, TelegramWebApp } from '@/types/telegram'

export type TelegramPlatform = 'telegram-mobile' | 'telegram-desktop' | 'web'

interface UseTelegramWebAppResult {
  telegram: TelegramWebApp | null
  initData: string | null
  user: TelegramUser | null
  startParam: string | null
  platform: TelegramPlatform
  isReady: boolean
  isMobile: boolean
}

const POLL_INTERVAL_MS = 80
const POLL_TIMEOUT_MS  = 2000
/**
 * Backoff: 80ms wakeups exist for the boot-ordering race, and every healthy
 * ordering resolves within the first ~2s. Past that the only realistic wait is
 * a slow SDK fetch, which 4 wakeups/s notice just as surely as 12.5.
 */
const POLL_SLOWDOWN_AFTER_MS = 2000
const POLL_SLOW_INTERVAL_MS  = 250
/**
 * Hard ceiling for a Telegram launch whose loader signal never arrives — the
 * DPI blackhole, where the request to telegram.org neither completes nor
 * errors, so neither `reiwa:telegram-sdk-ready` nor `-error` is ever
 * dispatched. Without it the poll ran forever. Hitting the ceiling takes the
 * SAME transition the bounded non-TMA wait takes (`finishAsWeb`): consumers
 * see `isReady` with no bridge, and — exactly like after that bounded wait — a
 * late `reiwa:telegram-sdk-ready` can still upgrade them to the real bridge.
 * Authentication does not ride on this: `initData` comes off the URL
 * (`telegram-launch-params.ts`) with no clock at all.
 */
const POLL_CEILING_MS = 20_000
const activatedApps = new WeakSet<object>()

/**
 * This hook is the SDK's consumer, not authentication's gatekeeper.
 *
 * It still loads and waits for the bridge, because the bridge is what supplies
 * haptics, BackButton/MainButton, the theme and `openInvoice` — the only call
 * that can raise Telegram's payment sheet. What it no longer does is decide
 * whether the user is in a Mini App: `lib/telegram-launch-params.ts` reads that
 * off the URL, before any script is fetched, so a blocked telegram.org costs
 * this session its native chrome and nothing more.
 */

interface UseTelegramWebAppOptions {
  /** Enable the one-time native `ready()` / `expand()` handshake. */
  readonly activate?: boolean
}

/**
 * A Telegram bridge can be exposed before it is fully usable. Never let a
 * host-side exception escape a React effect as an opaque `Script error.`.
 */
function callTelegramWebAppMethod(
  stage: 'ready' | 'expand' | 'disableVerticalSwipes' | 'isVersionAtLeast',
  callback: () => void,
): boolean {
  try {
    callback()
    return true
  } catch (error) {
    const detail = error instanceof Error && error.message.trim().length > 0
      ? `: ${error.message.slice(0, 500)}`
      : ''
    reportClientError({
      message: `Telegram WebApp ${stage}() failed${detail}`,
      stack: error instanceof Error ? error.stack : undefined,
      kind: 'telegram.webapp.initialization',
      errorName: error instanceof Error ? error.name : undefined,
    })
    return false
  }
}

/** Activate the Telegram host once per bridge object across all hook users. */
function activateTelegramWebApp(tg: TelegramWebApp): void {
  if (activatedApps.has(tg)) return
  activatedApps.add(tg)

  if (typeof tg.ready === 'function') {
    callTelegramWebAppMethod('ready', () => tg.ready?.())
  }
  if (typeof tg.expand === 'function') {
    callTelegramWebAppMethod('expand', () => tg.expand?.())
  }

  if (typeof tg.disableVerticalSwipes !== 'function' || typeof tg.isVersionAtLeast !== 'function') {
    return
  }
  let supportsVerticalSwipeControl = false
  const inspectedVersion = callTelegramWebAppMethod('isVersionAtLeast', () => {
    supportsVerticalSwipeControl = tg.isVersionAtLeast?.('7.7') === true
  })
  if (inspectedVersion && supportsVerticalSwipeControl) {
    callTelegramWebAppMethod('disableVerticalSwipes', () => tg.disableVerticalSwipes?.())
  }
}

// ── Shared bridge waiter ─────────────────────────────────────────────────────
// ONE poll for the whole page. Three hook instances mount on an entry screen
// (App root, ad-attribution, the /tma page), and each used to run its own
// 80ms interval — up to 3 × 12.5 wakeups/s, forever, when telegram.org was
// blackholed. What is waited FOR and the ready/error event semantics are
// unchanged from the per-instance version; only the waiting is shared, backed
// off, and capped.

type BridgeSubscriber = (bridge: TelegramWebApp | null) => void

interface BridgeWaiter {
  /** `web` is NOT terminal: a late sdk-ready can still upgrade to `telegram`. */
  status: 'pending' | 'web' | 'telegram'
  bridge: TelegramWebApp | null
  readonly subscribers: Set<BridgeSubscriber>
  /** Immediate re-read of the bridge — a new subscriber must not wait a tick. */
  check(): void
  /** Test-only teardown. */
  destroy(): void
}

let bridgeWaiter: BridgeWaiter | null = null

function createBridgeWaiter(): BridgeWaiter {
  const waiter: BridgeWaiter = {
    status: 'pending',
    bridge: null,
    subscribers: new Set(),
    check: () => {
      tryResolveBridge()
    },
    destroy: () => {
      stopTimers()
      detachSdkListeners()
      waiter.subscribers.clear()
    },
  }

  let poll: ReturnType<typeof setInterval> | null = null
  let slowdownTimer: number | null = null
  let webTimeout: number | null = null
  let ceilingTimer: number | null = null
  let sdkReadyFallbackTimeout: number | null = null

  const stopTimers = () => {
    if (poll !== null) {
      clearInterval(poll)
      poll = null
    }
    if (slowdownTimer !== null) {
      clearTimeout(slowdownTimer)
      slowdownTimer = null
    }
    if (webTimeout !== null) {
      clearTimeout(webTimeout)
      webTimeout = null
    }
    if (ceilingTimer !== null) {
      clearTimeout(ceilingTimer)
      ceilingTimer = null
    }
    if (sdkReadyFallbackTimeout !== null) {
      clearTimeout(sdkReadyFallbackTimeout)
      sdkReadyFallbackTimeout = null
    }
  }

  const detachSdkListeners = () => {
    window.removeEventListener('reiwa:telegram-sdk-ready', handleSdkReady)
    window.removeEventListener('reiwa:telegram-sdk-error', handleSdkError)
  }

  const notify = () => {
    for (const subscriber of [...waiter.subscribers]) subscriber(waiter.bridge)
  }

  const resolveTelegram = (tg: TelegramWebApp) => {
    waiter.status = 'telegram'
    waiter.bridge = tg
    // Terminal: nothing left to wait for, so the listeners go too.
    stopTimers()
    detachSdkListeners()
    notify()
  }

  /**
   * The same failure transition the per-instance hook took when its bounded
   * (non-TMA) wait expired: consumers become `isReady` with no bridge. The
   * sdk listeners stay attached — after the old timeout they survived until
   * unmount and a late `sdk-ready` still upgraded the session to the real
   * bridge (the payment-return document depends on exactly that), so `web`
   * stays upgradeable here as well.
   */
  const finishAsWeb = () => {
    stopTimers()
    if (waiter.status !== 'pending') return
    waiter.status = 'web'
    notify()
  }

  const tryResolveBridge = (): boolean => {
    if (waiter.status === 'telegram') return true
    const tg = window.Telegram?.WebApp
    if (!tg?.initData) return false
    resolveTelegram(tg)
    return true
  }

  const handleSdkReady = () => {
    if (tryResolveBridge()) return
    // The SDK has finished executing, so a missing usable bridge is no
    // longer a slow-network case. Give Telegram a short bridge-init grace
    // period, then unblock malformed/copied launch URLs as regular web.
    if (sdkReadyFallbackTimeout === null) {
      sdkReadyFallbackTimeout = window.setTimeout(() => {
        sdkReadyFallbackTimeout = null
        finishAsWeb()
      }, POLL_TIMEOUT_MS)
    }
  }
  const handleSdkError = () => {
    finishAsWeb()
  }

  // Try immediately — a bridge that is already up costs no timers at all.
  if (tryResolveBridge()) return waiter

  // Poll, at 80ms while a healthy boot ordering could still resolve, then
  // backed off to 250ms.
  poll = setInterval(() => {
    tryResolveBridge()
  }, POLL_INTERVAL_MS)
  slowdownTimer = window.setTimeout(() => {
    slowdownTimer = null
    if (poll === null) return
    clearInterval(poll)
    poll = setInterval(() => {
      tryResolveBridge()
    }, POLL_SLOW_INTERVAL_MS)
  }, POLL_SLOWDOWN_AFTER_MS)

  const launchedByTelegram = hasTelegramLaunchParameters()
  window.addEventListener('reiwa:telegram-sdk-ready', handleSdkReady)
  window.addEventListener('reiwa:telegram-sdk-error', handleSdkError)

  // A regular browser session has no SDK to wait for. A real Telegram
  // launch waits for the loader's explicit ready/error signal, so a slow
  // network can never prematurely downgrade Mini App authentication to web —
  // only the blackhole ceiling above ends the wait, and even that stays
  // upgradeable.
  if (launchedByTelegram) {
    ceilingTimer = window.setTimeout(() => {
      ceilingTimer = null
      finishAsWeb()
    }, POLL_CEILING_MS)
  } else {
    webTimeout = window.setTimeout(() => {
      webTimeout = null
      finishAsWeb()
    }, POLL_TIMEOUT_MS)
  }

  if (launchedByTelegram && window.__reiwaTelegramSdkState === 'error') {
    handleSdkError()
  } else if (
    launchedByTelegram &&
    window.__reiwaTelegramSdkState === 'ready'
  ) {
    handleSdkReady()
  }

  return waiter
}

/**
 * Test-only: drop the shared waiter (and its timers/listeners) so each spec
 * starts from a cold boot. Production code must never call this.
 */
export function __resetTelegramWebAppBridgeForTests(): void {
  bridgeWaiter?.destroy()
  bridgeWaiter = null
}

export function useTelegramWebApp(
  { activate = true }: UseTelegramWebAppOptions = {},
): UseTelegramWebAppResult {
  const [result, setResult] = useState<UseTelegramWebAppResult>({
    telegram: null,
    initData: null,
    user: null,
    startParam: null,
    platform: 'web',
    isReady: false,
    isMobile: false,
  })

  const appliedBridgeRef = useRef<TelegramWebApp | null>(null)

  useEffect(() => {
    const waiter = (bridgeWaiter ??= createBridgeWaiter())

    const apply: BridgeSubscriber = (tg) => {
      if (tg === null) {
        // Web resolution — only flips readiness; a later upgrade may follow.
        setResult(prev => (prev.isReady ? prev : { ...prev, isReady: true }))
        return
      }
      if (appliedBridgeRef.current === tg) return
      appliedBridgeRef.current = tg

      if (activate) activateTelegramWebApp(tg)

      const platform = tg.platform
      const isMobile  = platform === 'ios' || platform === 'android'
      const isDesktop = platform === 'tdesktop' || platform === 'macos'
      const telegramPlatform: TelegramPlatform =
        isMobile ? 'telegram-mobile' : isDesktop ? 'telegram-desktop' : 'web'

      setResult({
        telegram: tg,
        initData: tg.initData ?? null,
        user: tg.initDataUnsafe?.user ?? null,
        startParam: tg.initDataUnsafe?.start_param ?? null,
        platform: telegramPlatform,
        isReady: true,
        isMobile,
      })
    }

    waiter.subscribers.add(apply)
    // A bridge that is already up must not wait for the next poll tick — the
    // per-instance version read it synchronously on mount, and so does this.
    if (waiter.status !== 'telegram') waiter.check()
    if (waiter.status === 'telegram') {
      apply(waiter.bridge)
    } else if (waiter.status === 'web') {
      apply(null)
    }

    return () => {
      waiter.subscribers.delete(apply)
    }
  }, [activate])

  return result
}
