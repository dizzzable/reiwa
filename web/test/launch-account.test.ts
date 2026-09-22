// @vitest-environment jsdom

/**
 * The Telegram account a Mini App launch names — read, not verified — the one
 * question it lets the shell ask (is the cookie session somebody else's?), and
 * where the answer may switch accounts at all.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { isOtherTelegramAccount, isTelegramWebview, readLaunchAccount } from '../src/features/auth/launch-account'

const launchOf = (user: unknown) =>
  `query_id=Q&user=${encodeURIComponent(JSON.stringify(user))}&auth_date=1&hash=ab`

describe('the account a launch names', () => {
  it('is the user id as a string, with the first name for a label', () => {
    expect(readLaunchAccount(launchOf({ id: 5151, first_name: 'Anna', username: 'anna' }))).toEqual({
      id: '5151',
      label: 'Anna',
    })
  })

  it('labels with the username when there is no first name, and with nothing when there is neither', () => {
    expect(readLaunchAccount(launchOf({ id: 5151, first_name: '  ', username: 'anna' }))?.label).toBe('@anna')
    expect(readLaunchAccount(launchOf({ id: 5151 }))?.label).toBeNull()
  })

  it('is nothing — never a guess — without a readable user id', () => {
    expect(readLaunchAccount(null)).toBeNull()
    expect(readLaunchAccount('query_id=Q&auth_date=1&hash=ab')).toBeNull()
    expect(readLaunchAccount('user=%7Bnot-json&hash=ab')).toBeNull()
    expect(readLaunchAccount(launchOf({ id: '5151', first_name: 'Anna' }))).toBeNull()
    expect(readLaunchAccount(launchOf({ id: -1, first_name: 'Anna' }))).toBeNull()
  })
})

describe('is the session another Telegram account?', () => {
  const anna = { id: '5151', label: 'Anna' }

  it('yes, when both are Telegram accounts and they differ', () => {
    expect(isOtherTelegramAccount('4242', anna)).toBe(true)
  })

  it('no, when they are the same account', () => {
    expect(isOtherTelegramAccount('5151', anna)).toBe(false)
  })

  it('no, for a website account with no Telegram — that may be the same person', () => {
    expect(isOtherTelegramAccount(null, anna)).toBe(false)
    expect(isOtherTelegramAccount(undefined, anna)).toBe(false)
    expect(isOtherTelegramAccount('  ', anna)).toBe(false)
  })

  it('no, when there is no launch to compare with — a browser', () => {
    expect(isOtherTelegramAccount('4242', null)).toBe(false)
  })
})

describe('where a launch may take over the session: a Telegram client’s webview', () => {
  // A link can carry launch data anywhere; what it cannot bring is the client.
  const ANDROID_WEBVIEW =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36'
  const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Mobile Safari/537.36'
  const DESKTOP_CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  const originalUserAgent = navigator.userAgent

  function setUserAgent(ua: string): void {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
  }

  afterEach(() => {
    delete window.TelegramWebviewProxy
    setUserAgent(originalUserAgent)
  })

  it('yes, with the bridge Telegram injects — iOS, Telegram Desktop', () => {
    setUserAgent(DESKTOP_CHROME)
    window.TelegramWebviewProxy = { postEvent: () => undefined }
    expect(isTelegramWebview()).toBe(true)
  })

  it('yes, in an Android WebView, where the bridge may arrive after the page', () => {
    setUserAgent(ANDROID_WEBVIEW)
    expect(isTelegramWebview()).toBe(true)
  })

  it('no, in a browser — whatever the address says', () => {
    setUserAgent(ANDROID_CHROME)
    expect(isTelegramWebview()).toBe(false)
    setUserAgent(DESKTOP_CHROME)
    expect(isTelegramWebview()).toBe(false)
  })
})
