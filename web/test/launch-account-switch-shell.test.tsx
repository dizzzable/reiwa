// @vitest-environment jsdom

/**
 * One app, several Telegram accounts, one cookie store.
 *
 * The shell signs in from the cookie whenever there is one, so account B
 * opening the Mini App on a phone where account A signed in earlier was shown
 * A's cabinet without a word. Now the account that opened the app is the
 * account shown: the shell signs in as it — before any other gate, and without
 * asking. But only in a Telegram client's webview: in a browser the launch data
 * came from a link. Each case is one way to get that wrong again.
 */

import { act, type ReactNode, type SVGProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LAUNCH = `query_id=Q&user=${encodeURIComponent(JSON.stringify({ id: 5151, first_name: 'Anna' }))}&auth_date=1&hash=ab`
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

const Icon = (_props: SVGProps<SVGSVGElement>) => <svg />

const api = vi.hoisted(() => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
  bootstrapTelegram: vi.fn(),
}))
const sessionState = vi.hoisted(() => ({
  session: null as unknown,
  isLoading: false,
  isAuthenticated: true,
}))
/** What `/session` answers when the switch reads it back. */
const readBack = vi.hoisted(() => ({ fetchSessionOrNull: vi.fn() }))
const platformPolicy = vi.hoisted(() => ({ data: { requireTelegramWebCredentials: false } as unknown }))
const queryClient = vi.hoisted(() => ({ resetQueries: vi.fn(), invalidateQueries: vi.fn() }))
const launch = vi.hoisted(() => ({ value: null as string | null }))
const redirects = vi.hoisted(() => [] as string[])

vi.mock('@/lib/api-client', () => api)
vi.mock('@/lib/push', () => ({ ensurePushSubscription: vi.fn(async () => false) }))
vi.mock('@/hooks/use-session', () => ({
  SESSION_QUERY_KEY: ['session'],
  useSession: () => sessionState,
  fetchSessionOrNull: () => readBack.fetchSessionOrNull(),
}))
vi.mock('@/hooks/use-user-realtime', () => ({ useUserRealtime: () => undefined }))
vi.mock('@/hooks/use-is-desktop', () => ({ useIsDesktop: () => true }))
vi.mock('@/hooks/use-install-prompt', () => ({ isStandalonePwa: () => false }))
vi.mock('@/lib/branding-provider', () => ({ useBranding: () => ({ branding: {} }) }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => platformPolicy,
  useQueryClient: () => queryClient,
}))
vi.mock('@/lib/telegram-launch-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telegram-launch-params')>()),
  readTelegramLaunchInitData: () => launch.value,
}))
vi.mock('react-router', () => ({
  Navigate: ({ to }: { readonly to: string }) => {
    redirects.push(to)
    return null
  },
  NavLink: ({ to, children, ...rest }: { readonly to: string; readonly children?: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="route-content" />,
  useLocation: () => ({ pathname: '/dashboard', search: '' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('motion/react', () => ({
  domMax: {},
  LazyMotion: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  m: { span: (props: Record<string, unknown>) => <span {...(props as object)} /> },
}))
vi.mock('@/components/layout/use-nav-tabs', () => ({
  useNavTabs: () => [
    { to: '/dashboard', icon: Icon, label: 'Подписки', testId: 'tab-dashboard', matchPrefix: ['/dashboard'] },
  ],
  resolveActiveTabTo: () => '/dashboard',
}))
vi.mock('@/components/layout/side-nav', () => ({ SideNav: () => <nav data-testid="side-nav" /> }))
vi.mock('@/components/layout/route-content-boundary', () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}))
vi.mock('@/features/onboarding/onboarding-tour-controller', () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
  useOnboardingContext: () => ({
    startTour: () => undefined,
    replayTour: () => undefined,
    startDemo: () => undefined,
    isActive: false,
    autoStartPending: false,
  }),
}))
vi.mock('@/components/ui/network-bg', () => ({ NetworkBg: () => null }))
vi.mock('@/components/layout/app-background', () => ({ AppBackground: () => null }))

const { default: StealthLayout } = await import('@/components/layout/stealth-layout')

let root: Root | null = null
let host: HTMLDivElement | null = null
const originalUserAgent = navigator.userAgent

function render(): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(<StealthLayout />))
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
  redirects.length = 0
  launch.value = LAUNCH
  // Inside Telegram (iOS, Desktop): the bridge the client injects.
  setUserAgent(DESKTOP_CHROME)
  window.TelegramWebviewProxy = { postEvent: () => undefined }
  sessionState.session = ACCOUNT_A
  platformPolicy.data = { requireTelegramWebCredentials: false }
  api.reportSurface.mockResolvedValue({ ok: true })
  api.bootstrapTelegram.mockResolvedValue({ ok: true, redirectUrl: '/dashboard' })
  readBack.fetchSessionOrNull.mockResolvedValue(ACCOUNT_B)
  queryClient.resetQueries.mockResolvedValue(undefined)
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

  it('resets every query once the session IS the launch’s account — not only the session', async () => {
    render()
    await settle()
    expect(readBack.fetchSessionOrNull).toHaveBeenCalled()
    // No filter: the channel gate and anything else read for A answer again for B.
    expect(queryClient.resetQueries).toHaveBeenCalledWith()
  })

  it('never shows the previous account’s cabinet while switching, and says whose it opens', () => {
    const el = render()
    expect(cabinet(el)).toBeNull()
    expect(switching(el)?.getAttribute('data-state')).toBe('switching')
    expect(el.textContent).toContain('launchSwitch.signingInAs')
  })

  it('a switch that did not take is an error screen — no reset, no loop, no cabinet of A', async () => {
    // The bootstrap answered, and the cookie is still A's.
    readBack.fetchSessionOrNull.mockResolvedValue(ACCOUNT_A)
    const el = render()
    await settle()
    expect(switching(el)?.getAttribute('data-state')).toBe('failed')
    expect(queryClient.resetQueries).not.toHaveBeenCalled()
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
    expect(queryClient.resetQueries).toHaveBeenCalledTimes(1)
  })

  it('is switched BEFORE the claim gate, which would send the launch’s user to set the session’s password', () => {
    sessionState.session = { ...ACCOUNT_A, webAccount: null }
    platformPolicy.data = { requireTelegramWebCredentials: true }
    const el = render()
    expect(switching(el)).not.toBeNull()
    expect(redirects).toEqual([])
  })

  it('is switched in an Android WebView too, where the bridge may not be there yet', async () => {
    delete window.TelegramWebviewProxy
    setUserAgent(ANDROID_WEBVIEW)
    const el = render()
    expect(switching(el)).not.toBeNull()
    await settle()
    expect(api.bootstrapTelegram).toHaveBeenCalledWith(LAUNCH)
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
