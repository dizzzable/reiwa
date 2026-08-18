import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isExtensionOriginError, reportClientError } from '../src/lib/client-error-reporter'

/**
 * Wallet extensions must not reach the operator's error feed
 * ══════════════════════════════════════════════════════════
 * Two reports arrived in production on 2026-08-18 whose every stack frame lived
 * under `chrome-extension://` — one wallet losing a race to define
 * `window.ethereum`, and two wallets racing to register a Solana provider. They
 * were relayed with our service name, our version and our commit on them,
 * because they were thrown on our page and `window.onerror` cannot tell whose
 * code raised them.
 *
 * The existing `NON_REPORTABLE_PATTERNS` list cannot help: it matches on
 * wording, and these carry ordinary messages ("t is not a function"). Only the
 * ORIGIN separates them from a real crash.
 *
 * The payloads below are copied verbatim from those two reports rather than
 * invented, so this pins the actual traffic that caused the problem.
 */

const ETHEREUM_COLLISION = {
  message: 'Uncaught TypeError: Cannot redefine property: ethereum',
  filename: 'chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/evmAsk.js',
  stack: [
    'TypeError: Cannot redefine property: ethereum',
    '    at Object.defineProperty (<anonymous>)',
    '    at r.inject (chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/evmAsk.js:15:5093)',
    '    at window.addEventListener.once (chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/evmAsk.js:15:9013)',
  ].join('\n'),
  kind: 'window.onerror',
} as const

/** Note this one spans TWO different extensions — still nothing of ours. */
const SOLANA_REGISTRATION = {
  message: 'Uncaught TypeError: t is not a function',
  filename: 'chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/solana.js',
  stack: [
    'TypeError: t is not a function',
    '    at e (chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/solana.js:1:32545)',
    '    at chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/solana.js:2:76',
    '    at registerSolanaInjectedWallet (chrome-extension://fldfpgipfncgndfolcbkdeeknbbbnhcc/extensionPageScript.js:5885:10)',
    '    at initSolanaConnect (chrome-extension://fldfpgipfncgndfolcbkdeeknbbbnhcc/extensionPageScript.js:6167:10)',
  ].join('\n'),
  kind: 'window.onerror',
} as const

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
  vi.stubGlobal('fetch', fetchMock)
  // `sendBeacon` is the fallback path; stub it too, or a dropped `fetch` could
  // be mistaken for a dropped report.
  vi.stubGlobal('navigator', { ...globalThis.navigator, sendBeacon: vi.fn(() => true) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function sentBodies(): readonly Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
  )
}

describe('extension-origin errors never reach the operator feed', () => {
  it('drops the wallet collision that reached production', () => {
    reportClientError(ETHEREUM_COLLISION)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops an error whose frames span two different extensions', () => {
    reportClientError(SOLANA_REGISTRATION)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still reports a crash that merely PASSES THROUGH an extension', () => {
    // The case the "every frame" rule exists to protect. An extension calling
    // into our bundle and tripping a bug there is our bug, and a rule keyed on
    // "any extension frame" would have swallowed it.
    reportClientError({
      message: 'reiwa-only: subscription card failed to render',
      filename: 'https://app.example.com/assets/index-abc123.js',
      stack: [
        'TypeError: cannot read properties of undefined',
        '    at renderPlanCard (https://app.example.com/assets/index-abc123.js:42:7)',
        '    at inject (chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/evmAsk.js:15:5093)',
      ].join('\n'),
      kind: 'window.onerror',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentBodies()[0]?.['message']).toBe('reiwa-only: subscription card failed to render')
  })

  it('still reports an error that names no location at all', () => {
    // Unattributable is not the same as foreign. Dropping these would lose real
    // crashes from minified or cross-origin frames.
    reportClientError({
      message: 'reiwa-only: unattributable failure',
      stack: 'Error: boom\n    at <anonymous>\n    at <anonymous>',
      kind: 'unhandledrejection',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('isExtensionOriginError', () => {
  it('answers on the filename alone when there is no stack', () => {
    // `window.onerror` can hand us a location with no Error object behind it.
    expect(
      isExtensionOriginError({
        filename: 'moz-extension://abcdef/inject.js',
      }),
    ).toBe(true)
  })

  it('covers the schemes the other engines use, not just Chrome', () => {
    for (const scheme of [
      'chrome-extension',
      'moz-extension',
      'safari-web-extension',
      'safari-extension',
      'ms-browser-extension',
      'opera-extension',
    ]) {
      expect(isExtensionOriginError({ filename: `${scheme}://id/script.js` })).toBe(true)
    }
  })

  it('does NOT claim Safari masked URLs, which hide more than extensions', () => {
    // A deliberate false negative: `webkit-masked-url://` also covers scripts of
    // ours that Safari chose to hide, and silently discarding those would cost
    // real crashes.
    expect(
      isExtensionOriginError({ filename: 'webkit-masked-url://hidden/' }),
    ).toBe(false)
  })

  it('is not fooled by an extension URL appearing inside a message-like string', () => {
    // The scheme has to be where the code RAN, not merely mentioned.
    expect(
      isExtensionOriginError({
        filename: 'https://app.example.com/assets/index.js',
        stack: 'Error: chrome-extension:// is mentioned here\n    at f (https://app.example.com/assets/index.js:1:1)',
      }),
    ).toBe(false)
  })
})
