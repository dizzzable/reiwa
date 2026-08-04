import { useEffect, useRef, useState } from 'react'
import { reportClientError } from '@/lib/client-error-reporter'
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
const activatedApps = new WeakSet<object>()
const TELEGRAM_LAUNCH_PARAMETER_NAMES = [
  'tgWebAppData',
  'tgWebAppVersion',
  'tgWebAppPlatform',
  'tgWebAppThemeParams',
] as const

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

  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return

    const tryInit = () => {
      const tg = window.Telegram?.WebApp
      if (!tg?.initData) return false

      initializedRef.current = true

      if (activate) activateTelegramWebApp(tg)

      const platform = tg.platform
      const isMobile  = platform === 'ios' || platform === 'android'
      const isDesktop = platform === 'tdesktop' || platform === 'macos'
      const telegramPlatform: TelegramPlatform =
        isMobile ? 'telegram-mobile' : isDesktop ? 'telegram-desktop' : 'web'

      setResult({
        telegram: tg,
        initData: tg.initData,
        user: tg.initDataUnsafe?.user ?? null,
        startParam: tg.initDataUnsafe?.start_param ?? null,
        platform: telegramPlatform,
        isReady: true,
        isMobile,
      })
      return true
    }

    const hasTelegramLaunchParameters = (): boolean => {
      const search = new URLSearchParams(window.location.search)
      const hash = new URLSearchParams(
        window.location.hash.startsWith('#')
          ? window.location.hash.slice(1)
          : window.location.hash,
      )
      return TELEGRAM_LAUNCH_PARAMETER_NAMES.some(
        (name) => search.has(name) || hash.has(name),
      )
    }

    const finishAsWeb = () => {
      if (initializedRef.current) return
      initializedRef.current = true
      setResult(prev => ({ ...prev, isReady: true }))
    }

    // Try immediately
    if (tryInit()) return

    // Poll every 80ms
    const poll = setInterval(() => {
      if (tryInit()) clearInterval(poll)
    }, POLL_INTERVAL_MS)

    const launchedByTelegram = hasTelegramLaunchParameters()
    let sdkReadyFallbackTimeout: number | null = null
    const handleSdkReady = () => {
      if (tryInit()) {
        clearInterval(poll)
        return
      }
      // The SDK has finished executing, so a missing usable bridge is no
      // longer a slow-network case. Give Telegram a short bridge-init grace
      // period, then unblock malformed/copied launch URLs as regular web.
      if (sdkReadyFallbackTimeout === null) {
        sdkReadyFallbackTimeout = window.setTimeout(() => {
          clearInterval(poll)
          finishAsWeb()
        }, POLL_TIMEOUT_MS)
      }
    }
    const handleSdkError = () => {
      clearInterval(poll)
      finishAsWeb()
    }
    window.addEventListener('reiwa:telegram-sdk-ready', handleSdkReady)
    window.addEventListener('reiwa:telegram-sdk-error', handleSdkError)

    // A regular browser session has no SDK to wait for. A real Telegram
    // launch waits for the loader's explicit ready/error signal, so a slow
    // network can never permanently downgrade Mini App authentication to web.
    const timeout = launchedByTelegram
      ? null
      : window.setTimeout(() => {
          clearInterval(poll)
          finishAsWeb()
        }, POLL_TIMEOUT_MS)

    if (launchedByTelegram && window.__reiwaTelegramSdkState === 'error') {
      handleSdkError()
    } else if (
      launchedByTelegram &&
      window.__reiwaTelegramSdkState === 'ready'
    ) {
      handleSdkReady()
    }

    return () => {
      clearInterval(poll)
      if (timeout !== null) clearTimeout(timeout)
      if (sdkReadyFallbackTimeout !== null) {
        clearTimeout(sdkReadyFallbackTimeout)
      }
      window.removeEventListener('reiwa:telegram-sdk-ready', handleSdkReady)
      window.removeEventListener('reiwa:telegram-sdk-error', handleSdkError)
    }
  }, [activate])

  return result
}
