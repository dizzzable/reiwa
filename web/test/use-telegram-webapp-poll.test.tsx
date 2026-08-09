// @vitest-environment jsdom

/**
 * The Telegram-bridge poll must be one shared, backed-off, bounded wait.
 *
 * Three hook instances mount on an entry screen (App root, ad-attribution,
 * the /tma page). Each used to run its own 80ms `setInterval`, and with launch
 * parameters present nothing but the loader's ready/error event ever stopped
 * them — so a blackholed telegram.org (the documented DPI scenario for this
 * product) left up to 3 × 12.5 wakeups/s running forever.
 *
 * What must NOT change, and is asserted here too: `web` is not a final answer.
 * After the bounded wait — and now equally after the ceiling — a late
 * `reiwa:telegram-sdk-ready` still upgrades every consumer to the real bridge
 * (the payment-return document depends on that).
 */

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/client-error-reporter', () => ({ reportClientError: vi.fn() }))

import {
  useTelegramWebApp,
  __resetTelegramWebAppBridgeForTests,
} from '../src/hooks/use-telegram-webapp'
import type { TelegramWebApp } from '../src/types/telegram'

const TELEGRAM = 'Telegram' as const
const SDK_STATE = '__reiwaTelegramSdkState' as const
const INIT_DATA = 'user=%7B%22id%22%3A42%7D&auth_date=1&hash=deadbeef'

/** Latest hook result per probe id, refreshed on every render. */
const seen = new Map<string, ReturnType<typeof useTelegramWebApp>>()

function Probe({ id }: { readonly id: string }) {
  seen.set(id, useTelegramWebApp({ activate: false }))
  return null
}

function withLaunchParameters(): void {
  window.location.hash =
    `#tgWebAppData=${encodeURIComponent(INIT_DATA)}` +
    '&tgWebAppVersion=9.6&tgWebAppPlatform=ios'
}

function withSdkState(state: 'loading' | 'ready' | 'error' | undefined): void {
  if (state === undefined) {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, SDK_STATE)
    return
  }
  Object.defineProperty(window, SDK_STATE, { value: state, configurable: true, writable: true })
}

function withTelegramBridge(initData: string): void {
  const webApp = {
    initData,
    initDataUnsafe: { user: { id: 42 }, start_param: undefined },
    platform: 'ios',
  } as unknown as TelegramWebApp
  Object.defineProperty(window, TELEGRAM, {
    value: { WebApp: webApp },
    configurable: true,
    writable: true,
  })
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(element: ReactElement): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(element)
  })
}

function mountThreeProbes(): void {
  mount(
    <>
      <Probe id="app-root" />
      <Probe id="ad-attribution" />
      <Probe id="tma-page" />
    </>,
  )
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  seen.clear()
  window.history.replaceState({}, '', '/')
  window.location.hash = ''
  window.sessionStorage.clear()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, TELEGRAM)
  withSdkState(undefined)
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  __resetTelegramWebAppBridgeForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useTelegramWebApp shared bridge waiter', () => {
  it('runs ONE 80ms poll for three mounted consumers, not one each', () => {
    withLaunchParameters()
    withSdkState('loading')
    const intervalSpy = vi.spyOn(window, 'setInterval')

    mountThreeProbes()

    const fastPolls = intervalSpy.mock.calls.filter(([, delay]) => delay === 80)
    expect(
      fastPolls,
      'the 80ms bridge poll is per-hook-instance again — N mounted consumers means N intervals, all waiting for the same one thing',
    ).toHaveLength(1)
  })

  it('backs the shared poll off to 250ms after the first ~2s', async () => {
    withLaunchParameters()
    withSdkState('loading')
    const intervalSpy = vi.spyOn(window, 'setInterval')

    mountThreeProbes()
    expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 250)).toHaveLength(0)

    await elapse(2_000)

    expect(
      intervalSpy.mock.calls.filter(([, delay]) => delay === 250),
      'the poll never backed off — it is still spinning at 12.5 wakeups/s past the window in which any healthy boot ordering resolves',
    ).toHaveLength(1)
    // The 80ms interval is gone: from here on only the slow poll wakes up.
    expect(
      intervalSpy.mock.calls.filter(([, delay]) => delay === 80),
      'a second fast poll was started; the backoff must REPLACE the 80ms interval, not run alongside it',
    ).toHaveLength(1)
  })

  it('stops polling at the ceiling and takes the same web transition as the bounded wait', async () => {
    withLaunchParameters()
    withSdkState('loading')

    mountThreeProbes()

    // Just before the ceiling: still waiting, exactly like the old unbounded
    // Telegram wait — a slow SDK must not be downgraded early.
    await elapse(19_900)
    expect(seen.get('app-root')?.isReady).toBe(false)

    await elapse(200)

    for (const id of ['app-root', 'ad-attribution', 'tma-page']) {
      expect(
        seen.get(id)?.isReady,
        `${id} is still waiting past the ${20}s ceiling — a blackholed telegram.org leaves the poll running forever`,
      ).toBe(true)
      expect(
        seen.get(id)?.telegram,
        `${id} must reach the ceiling through the EXISTING web transition, with no bridge — not some new state`,
      ).toBeNull()
    }
    // Nothing keeps ticking once the ceiling has spoken.
    expect(
      vi.getTimerCount(),
      'timers are still scheduled after the ceiling — the poll was never actually stopped',
    ).toBe(0)
  })

  it('still upgrades every consumer when sdk-ready lands after the ceiling', async () => {
    withLaunchParameters()
    withSdkState('loading')

    mountThreeProbes()
    await elapse(20_100)
    expect(seen.get('tma-page')?.telegram).toBeNull()

    withTelegramBridge(INIT_DATA)
    withSdkState('ready')
    await act(async () => {
      window.dispatchEvent(new Event('reiwa:telegram-sdk-ready'))
      await vi.advanceTimersByTimeAsync(0)
    })

    for (const id of ['app-root', 'ad-attribution', 'tma-page']) {
      expect(seen.get(id)?.telegram).not.toBeNull()
      expect(seen.get(id)?.initData).toBe(INIT_DATA)
      expect(seen.get(id)?.isReady).toBe(true)
    }
  })

  it('keeps the bounded 2s wait for a launch with no Telegram parameters', async () => {
    mountThreeProbes()

    await elapse(1_900)
    expect(seen.get('app-root')?.isReady).toBe(false)

    await elapse(200)
    expect(seen.get('app-root')?.isReady).toBe(true)
    expect(seen.get('app-root')?.telegram).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves synchronously when the bridge is already up, with no timers at all', async () => {
    withLaunchParameters()
    withTelegramBridge(INIT_DATA)
    withSdkState('ready')

    mountThreeProbes()

    for (const id of ['app-root', 'ad-attribution', 'tma-page']) {
      expect(seen.get(id)?.isReady).toBe(true)
      expect(seen.get(id)?.initData).toBe(INIT_DATA)
      expect(seen.get(id)?.platform).toBe('telegram-mobile')
    }
    // Flush React's own zero-delay scheduler tasks; anything still pending
    // would be a waiter timer (poll/backoff/ceiling), and there must be none.
    await elapse(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
