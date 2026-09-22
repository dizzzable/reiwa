// @vitest-environment jsdom

/**
 * «Кабинет» → the phone's own browser, signed in: the two pages.
 *
 *   - `/open-in-browser`, the Mini App page «Кабинет» opens. Its key must be in
 *     hand BEFORE the tap, and the tap must hand `openLink` the address with no
 *     await in between: the mobile clients honour `openLink` only inside the
 *     physical tap, and a tap that waits for the network has lost it.
 *   - `/auth/open`, where that address lands. Inside Telegram's in-app browser
 *     on Android it must NOT spend the key but hand it to the default browser;
 *     anywhere else it IS the browser, and the key goes to the home page.
 *
 * And whose key: the request carries the tap's launch data, and when the
 * session is another Telegram account's (one app, several accounts, one cookie
 * store) the page offers to sign in as the account that tapped — on a tap,
 * never by itself.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'c3'.repeat(32)
const NEXT_KEY = 'd4'.repeat(32)
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36'
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const LAUNCH = `query_id=AAE&user=${encodeURIComponent(JSON.stringify({ id: 5151, first_name: 'Anna' }))}&auth_date=1&hash=ab`

const getBrowserKey = vi.fn<(initData: string) => Promise<{ key: string; expiresAt: string | null }>>()
const bootstrapTelegram = vi.fn<(initData: string) => Promise<{ ok: boolean }>>()
const invalidateQueries = vi.fn<(filters: unknown) => Promise<void>>()
const launch = vi.hoisted(() => ({ value: null as string | null }))
const openExternalUrl = vi.fn<(url: string) => void>()
const navigate = vi.fn<(to: string) => void>()
const platform = vi.hoisted(() => ({ value: 'android' as string | null }))
const leave = vi.hoisted(() => ({ replacePage: vi.fn<(url: string) => void>(), followLink: vi.fn<(url: string) => void>() }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ru' } }),
}))
vi.mock('react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/lib/api-client', () => ({
  getBrowserKey: (initData: string) => getBrowserKey(initData),
  bootstrapTelegram: (initData: string) => bootstrapTelegram(initData),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries }) }))
vi.mock('@/hooks/use-session', () => ({ SESSION_QUERY_KEY: ['session'] }))
vi.mock('@/lib/utils', () => ({ openExternalUrl: (url: string) => openExternalUrl(url) }))
vi.mock('@/lib/telegram-launch-params', () => ({
  readTelegramLaunchPlatform: () => platform.value,
  readTelegramLaunchInitData: () => launch.value,
}))
vi.mock('../src/features/auth/leave-page', () => leave)

const { default: OpenInBrowserPage } = await import('../src/features/auth/open-in-browser-page')
const { default: AuthOpenPage } = await import('../src/features/auth/auth-open-page')

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(element: React.ReactElement): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  platform.value = 'android'
  launch.value = LAUNCH
  getBrowserKey.mockResolvedValue({ key: KEY, expiresAt: null })
  bootstrapTelegram.mockResolvedValue({ ok: true })
  invalidateQueries.mockResolvedValue(undefined)
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('/open-in-browser — the Mini App page «Кабинет» opens', () => {
  it('has the key in hand before the tap, and hands openLink the address inside the tap', async () => {
    const el = render(<OpenInBrowserPage />)
    await settle()
    expect(getBrowserKey).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[data-testid="open-in-browser"]')?.getAttribute('data-state')).toBe('ready')
    // Nothing leaves before the tap on a phone.
    expect(openExternalUrl).not.toHaveBeenCalled()

    getBrowserKey.mockResolvedValue({ key: NEXT_KEY, expiresAt: null })
    const button = el.querySelector<HTMLButtonElement>('[data-open-in-browser]')
    act(() => button?.click())
    // Synchronously within the click: no await stood between the tap and openLink.
    expect(openExternalUrl).toHaveBeenCalledWith(`${window.location.origin}/auth/open#k=${KEY}`)

    // The browser is about to spend that key, so the next tap gets its own.
    await settle()
    act(() => el.querySelector<HTMLButtonElement>('[data-open-in-browser]')?.click())
    expect(openExternalUrl).toHaveBeenLastCalledWith(`${window.location.origin}/auth/open#k=${NEXT_KEY}`)
  })

  it('opens by itself on Telegram Desktop, which asks for no tap', async () => {
    platform.value = 'tdesktop'
    render(<OpenInBrowserPage />)
    await settle()
    expect(openExternalUrl).toHaveBeenCalledTimes(1)
    expect(openExternalUrl).toHaveBeenCalledWith(`${window.location.origin}/auth/open#k=${KEY}`)
  })

  it('says so, and offers a retry, when no key could be had', async () => {
    getBrowserKey.mockRejectedValue(new Error('502'))
    const el = render(<OpenInBrowserPage />)
    await settle()
    expect(el.querySelector('[data-testid="open-in-browser"]')?.getAttribute('data-state')).toBe('failed')
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('openInBrowser.failed')
    expect(el.querySelector('[data-open-in-browser]')).toBeNull()

    getBrowserKey.mockResolvedValue({ key: KEY, expiresAt: null })
    act(() => el.querySelector<HTMLButtonElement>('[data-open-in-browser-retry]')?.click())
    await settle()
    expect(el.querySelector('[data-testid="open-in-browser"]')?.getAttribute('data-state')).toBe('ready')
  })

  it('lets the customer stay in Telegram', async () => {
    const el = render(<OpenInBrowserPage />)
    await settle()
    act(() => el.querySelector<HTMLButtonElement>('[data-open-in-browser-stay]')?.click())
    expect(navigate).toHaveBeenCalledWith('/dashboard')
  })
})

function refusal(status: number, message: string): Error & { response: unknown } {
  return Object.assign(new Error(String(status)), { response: { status, data: { message } } })
}

describe('/open-in-browser — whose key', () => {
  it('asks with the launch data of the tap', async () => {
    render(<OpenInBrowserPage />)
    await settle()
    expect(getBrowserKey).toHaveBeenCalledWith(LAUNCH)
  })

  it('offers to sign in as the account that tapped when the session is another one — and waits for the tap', async () => {
    // Account 5151 tapped «Кабинет»; the app's shared cookie store holds another
    // account's session, and the server refused to key that session.
    getBrowserKey.mockRejectedValueOnce(refusal(409, 'LAUNCH_ACCOUNT_MISMATCH'))
    const el = render(<OpenInBrowserPage />)
    await settle()
    expect(el.querySelector('[data-testid="open-in-browser"]')?.getAttribute('data-state')).toBe('mismatch')
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('openInBrowser.mismatchBody')
    expect(el.querySelector('[data-open-in-browser]')).toBeNull()
    // Never by itself: launch data can also arrive in a crafted link.
    expect(bootstrapTelegram).not.toHaveBeenCalled()
    expect(openExternalUrl).not.toHaveBeenCalled()

    const switchButton = el.querySelector<HTMLButtonElement>('[data-open-in-browser-switch]')
    expect(switchButton?.textContent).toBe('openInBrowser.switchAs')
    act(() => switchButton?.click())
    await settle()
    // The server checks the HMAC before it signs anybody in; the page only asks.
    expect(bootstrapTelegram).toHaveBeenCalledWith(LAUNCH)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['session'] })
    expect(el.querySelector('[data-testid="open-in-browser"]')?.getAttribute('data-state')).toBe('ready')
  })

  it('asks to reopen from the bot when there is no launch data, and asks the server nothing', async () => {
    launch.value = null
    const el = render(<OpenInBrowserPage />)
    await settle()
    expect(el.querySelector('[data-testid="open-in-browser"]')?.getAttribute('data-state')).toBe('relaunch')
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('openInBrowser.relaunchBody')
    expect(getBrowserKey).not.toHaveBeenCalled()
  })

  it('asks to reopen from the bot when the server will not take the launch data', async () => {
    // Past its 24 hours, say — a retry would send the same bytes to the same refusal.
    getBrowserKey.mockRejectedValueOnce(refusal(401, 'LAUNCH_DATA_INVALID'))
    const el = render(<OpenInBrowserPage />)
    await settle()
    expect(el.querySelector('[data-testid="open-in-browser"]')?.getAttribute('data-state')).toBe('relaunch')
    expect(el.querySelector('[data-open-in-browser-retry]')).toBeNull()
  })
})

describe('/auth/open — where the address lands', () => {
  it('in Telegram’s in-app browser on Android: hands the key on to the default browser, spends nothing', () => {
    setUserAgent(ANDROID_WEBVIEW)
    window.history.replaceState({}, '', `/auth/open#k=${KEY}`)
    const el = render(<AuthOpenPage />)
    expect(el.querySelector('[data-testid="auth-open"]')?.getAttribute('data-plan')).toBe('hop')
    expect(leave.replacePage).not.toHaveBeenCalled()
    expect(leave.followLink).toHaveBeenCalledTimes(1)
    const intent = leave.followLink.mock.calls[0]?.[0] ?? ''
    expect(intent.startsWith(`intent://${window.location.host}/?signin=${KEY}#Intent;`)).toBe(true)
    // …and the button stays, for the tap Telegram may need.
    expect(el.querySelector('[data-auth-open-hop]')?.getAttribute('href')).toBe(intent)
  })

  it('anywhere else: IS the browser — the key goes to the home page, which spends it', () => {
    // ANTI-VACUITY for the one above: the same address, a real browser.
    setUserAgent(IPHONE_SAFARI)
    window.history.replaceState({}, '', `/auth/open#k=${KEY}`)
    render(<AuthOpenPage />)
    expect(leave.followLink).not.toHaveBeenCalled()
    expect(leave.replacePage).toHaveBeenCalledWith(`${window.location.origin}/?signin=${KEY}`)
  })

  it('wipes the key out of the address at once', () => {
    setUserAgent(IPHONE_SAFARI)
    window.history.replaceState({}, '', `/auth/open#k=${KEY}`)
    render(<AuthOpenPage />)
    expect(window.location.hash).toBe('')
  })

  it('says the link has expired, and goes nowhere, without a usable key', () => {
    setUserAgent(IPHONE_SAFARI)
    window.history.replaceState({}, '', '/auth/open#k=nope')
    const el = render(<AuthOpenPage />)
    expect(el.querySelector('[data-testid="auth-open"]')?.getAttribute('data-plan')).toBe('expired')
    expect(leave.replacePage).not.toHaveBeenCalled()
    expect(leave.followLink).not.toHaveBeenCalled()
    expect(el.querySelector('a[href="/sign-in"]')).not.toBeNull()
  })
})
