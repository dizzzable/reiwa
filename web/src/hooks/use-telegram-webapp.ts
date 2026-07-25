import { useEffect, useRef, useState } from 'react'
import { reportClientError } from '@/lib/client-error-reporter'

// Types for Telegram WebApp SDK
interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
  photo_url?: string
}

interface TelegramWebApp {
  initData: string
  initDataUnsafe: { user?: TelegramUser; start_param?: string }
  version: string
  platform: string
  colorScheme: 'light' | 'dark'
  themeParams: Record<string, string>
  isExpanded: boolean
  viewportHeight: number
  viewportStableHeight: number
  ready?: () => void
  expand?: () => void
  close: () => void
  isVersionAtLeast?: (version: string) => boolean
  /** Bot API 7.7+ — stop the swipe-down-to-minimise gesture that lets the
   *  whole Mini App be dragged (reads as "content out of bounds" on iOS). */
  disableVerticalSwipes?: () => void
  HapticFeedback: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void
    selectionChanged: () => void
  }
  BackButton: {
    isVisible: boolean
    show: () => void
    hide: () => void
    onClick: (cb: () => void) => void
    offClick: (cb: () => void) => void
  }
  MainButton: {
    text: string
    color: string
    textColor: string
    isVisible: boolean
    isProgressVisible: boolean
    isActive: boolean
    show: () => void
    hide: () => void
    enable: () => void
    disable: () => void
    setText: (text: string) => void
    onClick: (cb: () => void) => void
    offClick: (cb: () => void) => void
    showProgress: (leaveActive?: boolean) => void
    hideProgress: () => void
  }
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void
  openTelegramLink: (url: string) => void
  showPopup: (params: { title?: string; message: string; buttons?: Array<{ id?: string; type?: string; text?: string }> }, cb?: (id: string) => void) => void
  showAlert: (message: string, cb?: () => void) => void
  showConfirm: (message: string, cb?: (ok: boolean) => void) => void
  sendData: (data: string) => void
  switchInlineQuery: (query: string, choose_chat_types?: string[]) => void
  CloudStorage: {
    setItem: (key: string, value: string, cb?: (error: Error | null, stored?: boolean) => void) => void
    getItem: (key: string, cb: (error: Error | null, value?: string) => void) => void
    removeItem: (key: string, cb?: (error: Error | null, removed?: boolean) => void) => void
    getKeys: (cb: (error: Error | null, keys?: string[]) => void) => void
  }
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

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

    // Try immediately
    if (tryInit()) return

    // Poll every 80ms
    const poll = setInterval(() => {
      if (tryInit()) clearInterval(poll)
    }, POLL_INTERVAL_MS)

    // Fallback after timeout — work without Telegram (web browser)
    const timeout = setTimeout(() => {
      clearInterval(poll)
      if (!initializedRef.current) {
        initializedRef.current = true
        setResult(prev => ({ ...prev, isReady: true }))
      }
    }, POLL_TIMEOUT_MS)

    return () => {
      clearInterval(poll)
      clearTimeout(timeout)
    }
  }, [activate])

  return result
}
