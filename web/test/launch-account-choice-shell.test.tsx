// @vitest-environment jsdom

/**
 * One app, several Telegram accounts, one cookie store.
 *
 * The shell signs in from the cookie whenever there is one, so account B
 * opening the Mini App on a phone where account A signed in earlier was shown
 * A's cabinet without a word. Now the shell ASKS which one — before any other
 * gate — and never decides by itself: launch data can arrive in a crafted link
 * too. Each case is one way to get that wrong again.
 */

import { act, type ReactNode, type SVGProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LAUNCH = `query_id=Q&user=${encodeURIComponent(JSON.stringify({ id: 5151, first_name: 'Anna' }))}&auth_date=1&hash=ab`

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
const platformPolicy = vi.hoisted(() => ({ data: { requireTelegramWebCredentials: false } as unknown }))
const queryClient = vi.hoisted(() => ({ invalidateQueries: vi.fn() }))
const launch = vi.hoisted(() => ({ value: null as string | null }))
const redirects = vi.hoisted(() => [] as string[])

vi.mock('@/lib/api-client', () => api)
vi.mock('@/lib/push', () => ({ ensurePushSubscription: vi.fn(async () => false) }))
vi.mock('@/hooks/use-session', () => ({
  SESSION_QUERY_KEY: ['session'],
  useSession: () => sessionState,
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

const choice = (el: HTMLElement) => el.querySelector('[data-testid="launch-account-choice"]')
const cabinet = (el: HTMLElement) => el.querySelector('[data-testid="route-content"]')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  window.sessionStorage.clear()
  redirects.length = 0
  launch.value = LAUNCH
  sessionState.session = { id: 'acc-a', telegramId: '4242', name: 'Boris', webAccount: { login: 'boris' } }
  platformPolicy.data = { requireTelegramWebCredentials: false }
  api.reportSurface.mockResolvedValue({ ok: true })
  api.bootstrapTelegram.mockResolvedValue({ ok: true, redirectUrl: '/dashboard' })
  queryClient.invalidateQueries.mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('a session that is another Telegram account than the launch', () => {
  it('is asked about, and its cabinet is not shown meanwhile', () => {
    const el = render()
    expect(choice(el)).not.toBeNull()
    expect(cabinet(el)).toBeNull()
  })

  it('is never switched away from by itself', async () => {
    render()
    await settle()
    expect(api.bootstrapTelegram).not.toHaveBeenCalled()
  })

  it('«Войти как …» signs in as the launch’s account through the verified bootstrap', async () => {
    const el = render()
    act(() => el.querySelector<HTMLButtonElement>('[data-launch-choice-switch]')?.click())
    await settle()
    expect(api.bootstrapTelegram).toHaveBeenCalledWith(LAUNCH)
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['session'] })
  })

  it('«Остаться как …» shows the session’s cabinet, and is not asked again in this launch', () => {
    const el = render()
    act(() => el.querySelector<HTMLButtonElement>('[data-launch-choice-stay]')?.click())
    expect(choice(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()

    act(() => root?.unmount())
    host?.remove()
    const again = render()
    expect(choice(again)).toBeNull()
    expect(cabinet(again)).not.toBeNull()
  })

  it('is asked BEFORE the claim gate, which would send the launch’s user to set the session’s password', () => {
    sessionState.session = { id: 'acc-a', telegramId: '4242', name: 'Boris', webAccount: null }
    platformPolicy.data = { requireTelegramWebCredentials: true }
    const el = render()
    expect(choice(el)).not.toBeNull()
    expect(redirects).toEqual([])
  })
})

describe('everyone else goes straight in', () => {
  it('the same account', () => {
    sessionState.session = { id: 'acc-b', telegramId: '5151', name: 'Anna', webAccount: { login: 'anna' } }
    const el = render()
    expect(choice(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
  })

  it('a website account with no Telegram — it may be the same person', () => {
    sessionState.session = { id: 'acc-w', telegramId: null, name: 'Web', webAccount: { login: 'web' } }
    const el = render()
    expect(choice(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
  })

  it('a browser, with no launch data to compare', () => {
    launch.value = null
    const el = render()
    expect(choice(el)).toBeNull()
    expect(cabinet(el)).not.toBeNull()
  })
})
