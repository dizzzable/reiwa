// @vitest-environment jsdom

/**
 * One app, several Telegram accounts, one cookie store.
 *
 * The cabinet signs in from the cookie whenever there is one, so account B
 * opening the Mini App on a phone where account A signed in earlier was shown
 * A's cabinet without a word. Now the account that opened the app is the
 * account shown: `LaunchAccountGate` signs in as it — above the channel gate,
 * without asking — and reloads, so nothing of A's survives. But only in a
 * Telegram client's webview: in a browser the launch data came from a link.
 * Each case is one way to get that wrong again.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LAUNCH = `query_id=Q&user=${encodeURIComponent(JSON.stringify({ id: 5151, first_name: 'Anna' }))}&auth_date=1&hash=ab`
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

const api = vi.hoisted(() => ({ bootstrapTelegram: vi.fn() }))
const sessionState = vi.hoisted(() => ({ session: null as unknown, isLoading: false }))
/** What `/session` answers when the switch reads it back. */
const readBack = vi.hoisted(() => ({ fetchSessionOrNull: vi.fn() }))
const launch = vi.hoisted(() => ({ value: null as string | null }))
const leave = vi.hoisted(() => ({ reloadPage: vi.fn(), replacePage: vi.fn(), followLink: vi.fn() }))

vi.mock('@/lib/api-client', () => api)
vi.mock('@/hooks/use-session', () => ({
  SESSION_QUERY_KEY: ['session'],
  useSession: () => sessionState,
  fetchSessionOrNull: () => readBack.fetchSessionOrNull(),
}))
vi.mock('@/lib/telegram-launch-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telegram-launch-params')>()),
  readTelegramLaunchInitData: () => launch.value,
}))
vi.mock('../src/features/auth/leave-page', () => leave)
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const { LaunchAccountGate } = await import('../src/features/auth/launch-account-switch')

let root: Root | null = null
let host: HTMLDivElement | null = null
const originalUserAgent = navigator.userAgent

function render(): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <LaunchAccountGate fallback={<div data-testid="loader" />}>
        <div data-testid="route-content" />
      </LaunchAccountGate>,
    ),
  )
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

const switching = (el: HTMLElement) => el.querySelector('[data-testid="launch-account-switch"]')
const cabinet = (el: HTMLElement) => el.querySelector('[data-testid="route-content"]')

const ACCOUNT_A = { id: 'acc-a', telegramId: '4242', name: 'Boris', webAccount: { login: 'boris' } }
const ACCOUNT_B = { id: 'acc-b', telegramId: '5151', name: 'Anna', webAccount: { login: 'anna' } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  launch.value = LAUNCH
  // Inside Telegram (iOS, Desktop): the bridge the client injects.
  setUserAgent(DESKTOP_CHROME)
  window.TelegramWebviewProxy = { postEvent: () => undefined }
  sessionState.session = ACCOUNT_A
  sessionState.isLoading = false
  api.bootstrapTelegram.mockResolvedValue({ ok: true, redirectUrl: '/dashboard' })
  readBack.fetchSessionOrNull.mockResolvedValue(ACCOUNT_B)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  delete window.TelegramWebviewProxy
  setUserAgent(originalUserAgent)
})

describe('a session that is another Telegram account than the launch', () => {
  it('is left for the launch’s account — through the verified bootstrap, without a question', async () => {
    const el = render()
    expect(switching(el)).not.toBeNull()
    expect(cabinet(el)).toBeNull()
    // Nothing to choose: no «Остаться как …», no «Войти как …».
    expect(el.querySelectorAll('button')).toHaveLength(0)
    await settle()
    expect(api.bootstrapTelegram).toHaveBeenCalledWith(LAUNCH)
    expect(api.bootstrapTelegram).toHaveBeenCalledTimes(1)
  })

  it('reloads once the session IS the launch’s account, so nothing of the previous one survives', async () => {
    render()
    await settle()
    expect(readBack.fetchSessionOrNull).toHaveBeenCalled()
    // A cache reset would leave the previous account's live-updates stream running.
    expect(leave.reloadPage).toHaveBeenCalledTimes(1)
  })

  it('never shows the previous account’s cabinet while switching, and says whose it opens', () => {
    const el = render()
    expect(cabinet(el)).toBeNull()
    expect(switching(el)?.getAttribute('data-state')).toBe('switching')
    expect(el.textContent).toContain('launchSwitch.signingInAs')
  })

  it('a switch that did not take is an error screen — no reload, no loop, no cabinet of A', async () => {
    // The bootstrap answered, and the cookie is still A's.
    readBack.fetchSessionOrNull.mockResolvedValue(ACCOUNT_A)
    const el = render()
    await settle()
    expect(switching(el)?.getAttribute('data-state')).toBe('failed')
    expect(leave.reloadPage).not.toHaveBeenCalled()
    expect(api.bootstrapTelegram).toHaveBeenCalledTimes(1)
    expect(cabinet(el)).toBeNull()
  })

  it('a refused bootstrap is an error screen whose retry signs in again', async () => {
    api.bootstrapTelegram.mockRejectedValueOnce(new Error('401'))
    const el = render()
    await settle()
    expect(switching(el)?.getAttribute('data-state')).toBe('failed')
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('launchSwitch.failed')
    expect(cabinet(el)).toBeNull()

    act(() => el.querySelector<HTMLButtonElement>('[data-launch-switch-retry]')?.click())
    await settle()
    expect(api.bootstrapTelegram).toHaveBeenCalledTimes(2)
    expect(leave.reloadPage).toHaveBeenCalledTimes(1)
  })

  it('a refusal says why — reopening the app would only repeat it', async () => {
    // The account that opened the app may not sign in at all: invite-only
    // registration, registration closed, a ban. The first launch explains that;
    // the switch said only «try again».
    api.bootstrapTelegram.mockRejectedValue(
      Object.assign(new Error('403'), { response: { status: 403, data: { code: 'INVITE_REQUIRED' } } }),
    )
    const el = render()
    await settle()
    expect(switching(el)?.getAttribute('data-state')).toBe('failed')
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('bootstrap.inviteRequired')
    expect(cabinet(el)).toBeNull()
    expect(leave.reloadPage).not.toHaveBeenCalled()
  })

  it('is switched in an Android WebView too, where the bridge may not be there yet', async () => {
    delete window.TelegramWebviewProxy
    setUserAgent(ANDROID_WEBVIEW)
    const el = render()
    expect(switching(el)).not.toBeNull()
    await settle()
    expect(api.bootstrapTelegram).toHaveBeenCalledWith(LAUNCH)
  })

  it('draws nothing below while the session is still being read', () => {
    sessionState.isLoading = true
    const el = render()
    expect(el.querySelector('[data-testid="loader"]')).not.toBeNull()
    expect(cabinet(el)).toBeNull()
    expect(api.bootstrapTelegram).not.toHaveBeenCalled()
  })
})

describe('everyone else goes straight in', () => {
  it('the same account', () => {
    sessionState.session = ACCOUNT_B
    const el = render()
    expect(switching(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
  })

  it('a website account with no Telegram — it may be the same person', () => {
    sessionState.session = { id: 'acc-w', telegramId: null, name: 'Web', webAccount: { login: 'web' } }
    const el = render()
    expect(switching(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
  })

  it('nobody signed in — the Mini App sign-in takes it from there', () => {
    sessionState.session = null
    const el = render()
    expect(switching(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
  })

  it('a Mini App with no launch data to compare', () => {
    launch.value = null
    const el = render()
    expect(switching(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
  })

  it('a browser, even with somebody’s launch data in the address — a link must not switch accounts', async () => {
    delete window.TelegramWebviewProxy
    setUserAgent(DESKTOP_CHROME)
    const el = render()
    expect(switching(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
    await settle()
    expect(api.bootstrapTelegram).not.toHaveBeenCalled()
  })
})

describe('App.tsx', () => {
  it('puts the switch OUTSIDE «Канал обязателен», which asks about the session’s account', () => {
    // Inside it, B met A's channel screen — which no subscription of B's lifts —
    // or walked in on A's subscription.
    const app = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
    const open = app.indexOf('<LaunchAccountGate')
    const gate = app.indexOf('<ChannelGate')
    const gateEnd = app.indexOf('</ChannelGate>')
    const close = app.indexOf('</LaunchAccountGate>')
    expect(open).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(open)
    expect(close).toBeGreaterThan(gateEnd)
  })
})
