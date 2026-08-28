// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeDeviceHash, readOrCreateInstallId } from '@/lib/device-signals'

/**
 * The two device signals the cabinet derives about the browser it runs in.
 *
 * ── What is actually worth testing here ──────────────────────────────────
 *
 * Not the entropy — that is a property of the machine, not of this code. What
 * matters is the behaviour that decides whether the signal is USABLE:
 *
 *   • the install id survives losing either storage, because they are cleared
 *     by different actions and expire under different rules;
 *   • the id is not regenerated when it cannot be stored, because a fresh
 *     "device" on every page load fills the table with rows that match nothing;
 *   • the hash refuses to be computed from too little, because a digest of the
 *     core count alone is shared by millions and would match strangers;
 *   • nothing throws when a browser refuses a component, because the visitors
 *     who refuse the most are precisely the ones worth observing.
 */

const COOKIE_NAME = 'rz_device'
const STORAGE_KEY = 'rz.device'
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let cookieJar = ''

beforeEach(() => {
  cookieJar = ''
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookieJar,
    set: (value: string) => {
      const [pair] = value.split(';')
      cookieJar = cookieJar.length === 0 ? pair : `${cookieJar}; ${pair}`
    },
  })
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the install id', () => {
  it('creates one and writes it to BOTH stores', async () => {
    const id = readOrCreateInstallId()

    expect(id).not.toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(id)
    expect(cookieJar).toContain(`${COOKIE_NAME}=${id}`)
  })

  it('returns the same id on the next visit', async () => {
    const first = readOrCreateInstallId()
    const second = readOrCreateInstallId()
    expect(second).toBe(first)
  })

  it('restores the cookie from storage after a cookie clear', () => {
    // "Clear cookies" in most browsers leaves localStorage alone. Without this
    // the cheap signal would die on an action that does not touch the copy that
    // survived it.
    window.localStorage.setItem(STORAGE_KEY, ID)

    expect(readOrCreateInstallId()).toBe(ID)
    expect(cookieJar).toContain(`${COOKIE_NAME}=${ID}`)
  })

  it('restores storage from the cookie after storage is cleared', () => {
    // The mirror image, and the one Safari makes real: its tracking prevention
    // caps SCRIPT-WRITTEN storage at seven days of inactivity while leaving a
    // cookie alive longer.
    cookieJar = `${COOKIE_NAME}=${ID}`

    expect(readOrCreateInstallId()).toBe(ID)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(ID)
  })

  it('reports nothing when neither store will keep the value', () => {
    // A private window with storage disabled. Returning a fresh id anyway would
    // mean a brand-new "device" on every page load — rows that can never match
    // anything, in the table whose whole purpose is matching.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is disabled')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is disabled')
    })
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: () => undefined,
    })

    expect(readOrCreateInstallId()).toBeNull()
  })

  it('ignores a stored value that is not shaped like an id', () => {
    // Anything can end up in localStorage. A junk value would be reported as a
    // device and shared by everybody whose browser extension wrote the same
    // junk.
    window.localStorage.setItem(STORAGE_KEY, '{"not":"an id"}')

    const id = readOrCreateInstallId()
    expect(id).not.toBe('{"not":"an id"}')
    expect(id).not.toBeNull()
  })
})

describe('the device hash', () => {
  it('refuses to answer from too few components', async () => {
    // jsdom has no WebGL, no canvas rasterisation and no audio rendering, so
    // only the hardware line survives — a digest of the core count, which
    // millions of people share. Reporting it would manufacture matches between
    // strangers, and a flag raised on that sends an operator after a family.
    expect(await computeDeviceHash()).toBeNull()
  })

  it('produces a stable hex digest once enough components exist', async () => {
    // Two components is the floor. The exact value is not asserted — it is a
    // property of the machine — but its SHAPE and its STABILITY across calls
    // are the contract every stored value depends on.
    const canvas = HTMLCanvasElement.prototype as unknown as {
      toDataURL: () => string
      getContext: (id: string) => unknown
    }
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      textBaseline: '',
      font: '',
      fillStyle: '',
      fillRect: () => undefined,
      fillText: () => undefined,
    })
    vi.spyOn(canvas, 'toDataURL').mockReturnValue(`data:image/png;base64,${'A'.repeat(200)}`)

    const first = await computeDeviceHash()
    const second = await computeDeviceHash()

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toBe(first)
  })

  it('changes when the machine does', async () => {
    // The control for the test above: a digest that were constant would be
    // stable AND useless, and would match every visitor to every other.
    const canvas = HTMLCanvasElement.prototype as unknown as {
      toDataURL: () => string
      getContext: (id: string) => unknown
    }
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      textBaseline: '',
      font: '',
      fillStyle: '',
      fillRect: () => undefined,
      fillText: () => undefined,
    })

    vi.spyOn(canvas, 'toDataURL').mockReturnValue(`data:image/png;base64,${'A'.repeat(200)}`)
    const onGpu = await computeDeviceHash()
    vi.spyOn(canvas, 'toDataURL').mockReturnValue(`data:image/png;base64,${'B'.repeat(200)}`)
    const onAnother = await computeDeviceHash()

    expect(onAnother).not.toBe(onGpu)
  })

  it('never throws when a browser refuses a component', async () => {
    // The visitors who block the most are exactly the ones worth observing, so
    // a refusal has to cost a component, never the call.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('canvas is blocked')
    })

    await expect(computeDeviceHash()).resolves.toBeDefined()
  })
})
