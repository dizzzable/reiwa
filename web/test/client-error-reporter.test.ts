import { describe, expect, it } from 'vitest'

import { NON_REPORTABLE_PATTERNS } from "../src/lib/client-error-reporter"

/**
 * THE LIST THAT DECIDES WHAT THE OPERATOR NEVER HEARS.
 *
 * Every pattern here removes a class of report from the operator's error feed
 * forever. That makes this the single most dangerous file to widen carelessly:
 * a pattern one character too broad does not produce a wrong alert, it
 * produces NO alert, and the absence of an alert is indistinguishable from
 * everything being fine.
 *
 * So each entry is pinned twice — once for what it must silence, and once for
 * something adjacent it must NOT. A spec that only proved the silencing would
 * pass against `/./`.
 */
const silenced = (message: string): boolean =>
  NON_REPORTABLE_PATTERNS.some((re) => re.test(message))

describe('the noise filter silences noise and nothing else', () => {
  it('silences the shader texture race reported from iOS', () => {
    // Production, 2026-08-24, iOS 18.7, once per page view: a WebGL card
    // effect losing a race to bind its own internal noise texture. The texture
    // belongs to `@paper-design/shaders` and is loaded inside it — nothing in
    // this repository passes an image — so there is no version of this the
    // operator can act on.
    expect(silenced('Paper Shaders: image for uniform u_noiseTexture must be fully loaded')).toBe(
      true,
    )
  })

  it('silences it for any uniform, not only the one that was reported', () => {
    expect(silenced('Paper Shaders: image for uniform u_image must be fully loaded')).toBe(true)
  })

  it('still hears a REAL shader failure', () => {
    // ANTI-VACUITY, and the edge that matters. `/paper shaders/i` would pass
    // the two specs above and quietly delete every genuine WebGL failure —
    // context loss, a shader that will not compile — from the feed.
    expect(silenced('Paper Shaders: failed to compile fragment shader')).toBe(false)
    expect(silenced('WebGL context lost')).toBe(false)
  })

  it('still silences the service-worker churn it was written for', () => {
    // Guards the entries that were already here against a careless edit to the
    // array: these are the routine-on-redeploy ones.
    expect(silenced('Failed to update a ServiceWorker for scope https://2get.shop/')).toBe(true)
    expect(silenced('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
  })

  it('hears an ordinary application crash', () => {
    // The whole point of the feed. If this ever goes true, the filter has
    // eaten the thing it exists to protect.
    expect(silenced('TypeError: t.subscriptions is not a function')).toBe(false)
    expect(silenced('Cannot read properties of undefined (reading id)')).toBe(false)
  })
})
