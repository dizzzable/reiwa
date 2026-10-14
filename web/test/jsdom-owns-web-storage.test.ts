// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

/**
 * A jsdom spec must see JSDOM's `localStorage` and `sessionStorage`.
 *
 * Node 25 turned its own Web Storage on by default. On Node 26 `localStorage`
 * and `sessionStorage` are accessors already present on `globalThis`, and
 * vitest's jsdom environment does not replace a global that exists unless it is
 * on its short list of DOM class names (`Storage` is on it, the two instances
 * are not). Left alone, a spec met Node's `localStorage` — `undefined` without
 * `--localstorage-file`, so eighteen `web/test` files failed — and Node's
 * `sessionStorage`, a different class from the `Storage` a spec stubs.
 *
 * `vitest.config.ts` keeps Node's storage off in the test workers
 * (`execArgv: ['--no-experimental-webstorage']`). This file is the tripwire for
 * that line: take it out, or let a Node release change the arrangement, and the
 * specs that stub `Storage.prototype` would silently stop reaching what the
 * code under test reads. Here that shows as one red file instead.
 */
describe('the storage a jsdom spec sees', () => {
  it('is jsdom’s: it exists, holds what is written, and is empty again after clear()', () => {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      expect(storage).toBeDefined()
      storage.clear()
      storage.setItem('k', 'v')
      expect(storage.getItem('k')).toBe('v')
      storage.clear()
      expect(storage.getItem('k')).toBeNull()
    }
  })

  it('answers to a stub on Storage.prototype, for localStorage and sessionStorage alike', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    try {
      expect(() => window.localStorage.getItem('k')).toThrow('storage unavailable')
      expect(() => window.sessionStorage.getItem('k')).toThrow('storage unavailable')
    } finally {
      getItem.mockRestore()
    }
    expect(window.localStorage.getItem('k')).toBeNull()
  })
})
