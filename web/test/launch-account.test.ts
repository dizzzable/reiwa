// @vitest-environment jsdom

/**
 * The Telegram account a Mini App launch names — read, not verified — and the
 * one question it lets the shell ask: is the cookie session somebody else's?
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  isOtherTelegramAccount,
  readLaunchAccount,
  readStayChoice,
  rememberStay,
  stayChoiceFor,
} from '../src/features/auth/launch-account'

const launchOf = (user: unknown) =>
  `query_id=Q&user=${encodeURIComponent(JSON.stringify(user))}&auth_date=1&hash=ab`

beforeEach(() => {
  window.sessionStorage.clear()
})

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

describe('«Остаться как …»', () => {
  const anna = { id: '5151', label: 'Anna' }

  it('is remembered for this launch, for that exact pair of accounts', () => {
    expect(readStayChoice()).toBeNull()
    expect(rememberStay(anna, '4242')).toBe(stayChoiceFor(anna, '4242'))
    expect(readStayChoice()).toBe(stayChoiceFor(anna, '4242'))
    // Another session under the same launch is a new question.
    expect(readStayChoice()).not.toBe(stayChoiceFor(anna, '7777'))
  })
})
