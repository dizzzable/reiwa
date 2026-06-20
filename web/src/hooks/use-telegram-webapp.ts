import { useEffect, useRef, useState } from 'react'

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
  ready: () => void
  expand: () => void
  close: () => void
  isVersionAtLeast: (version: string) => boolean
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

export function useTelegramWebApp(): UseTelegramWebAppResult {
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

      // Signal to Telegram that we're ready
      tg.ready()
      tg.expand()

      // Stop the vertical swipe-to-minimise drag (Bot API 7.7+) so the Mini
      // App can't be pulled around — on iOS that drag is what makes content
      // look like it slips out of bounds. Guarded: older clients lack it.
      if (typeof tg.disableVerticalSwipes === 'function' && tg.isVersionAtLeast('7.7')) {
        tg.disableVerticalSwipes()
      }

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
  }, [])

  return result
}
