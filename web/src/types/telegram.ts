/**
 * The Telegram WebApp SDK surface, and the `window` globals the Mini App
 * bootstrap relies on.
 *
 * ── THE SINGLE SOURCE OF TRUTH FOR `window.Telegram`. DO NOT DECLARE IT AGAIN. ──
 *
 * There used to be two `declare global { interface Window { Telegram?: … } }`
 * blocks — one here-ish (`src/vite-env.d.ts`) and one inside
 * `src/hooks/use-telegram-webapp.ts` — describing the same property with two
 * different object types. Declaration merging normally rejects that with
 * TS2717 ("subsequent property declarations must have the same type"), but
 * `tsconfig.app.json` sets `skipLibCheck: true`, which silences the conflict
 * as soon as either copy lives in a `.d.ts`. So the compiler said nothing, one
 * copy silently won member resolution, and the other sat there looking
 * authoritative while being dead weight.
 *
 * The cost was real: adding `openInvoice` to the `.d.ts` copy alone still
 * produced `TS2339: Property 'openInvoice' does not exist on type
 * 'TelegramWebApp'` at `lib/utils.ts`, because the *other* copy was the one in
 * force. It had to be added to both to compile.
 *
 * `skipLibCheck` will hide the next duplicate exactly the same way, so this
 * prose is the guard — there is no compiler error to rely on. Add members
 * HERE. This module deliberately imports nothing, so anything (including a
 * `.d.ts`) can depend on it without dragging React in.
 *
 * Optionality is not decoration. These members arrive from a script fetched
 * from telegram.org at runtime and the set differs by client version and Bot
 * API level; a member typed as required but absent on an older client is a
 * runtime crash the compiler promised could not happen. When in doubt, `?`.
 */

export interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
  photo_url?: string
}

export interface TelegramWebApp {
  /** Absent until the bridge is initialised, and empty outside a Mini App. */
  initData?: string
  initDataUnsafe?: { user?: TelegramUser; start_param?: string }
  version: string
  platform: string
  colorScheme?: 'light' | 'dark'
  themeParams?: Record<string, string>
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
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void
    selectionChanged: () => void
  }
  BackButton?: {
    isVisible: boolean
    show: () => void
    hide: () => void
    onClick: (cb: () => void) => void
    offClick: (cb: () => void) => void
  }
  MainButton?: {
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
  /** Bot API 6.0+ — optional because `lib/utils.ts` falls back down the bridge
   *  chain rather than assume any one of them shipped. */
  openTelegramLink?: (url: string) => void
  /** Bot API 6.1+ — raises the native payment sheet for an invoice link
   *  (`t.me/$<slug>` or `t.me/invoice/<slug>`) and keeps the Mini App open;
   *  throws `WebAppInvoiceUrlInvalid` on anything else. Telegram Stars checkout
   *  URLs are invoice links, so this is the only call that can take a payment;
   *  `openLink` merely shows the t.me landing page in the in-app browser.
   *  Optional because clients older than 6.1 never shipped it. */
  openInvoice?: (url: string, callback?: (status: string) => void) => void
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
    /**
     * Stamped by `public/telegram-webapp-loader.js` before it requests the SDK
     * and left in place when that request fails, so `isTelegramLaunch()` in
     * `lib/utils.ts` can still recognise a Mini App on a network that cannot
     * reach telegram.org.
     */
    __reiwaTelegramSdkState?: 'loading' | 'ready' | 'error'
  }
}
