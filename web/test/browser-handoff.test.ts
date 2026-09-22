import { describe, expect, it } from 'vitest'

import {
  androidDefaultBrowserIntent,
  browserOpenUrl,
  isAndroidWebView,
  opensWithoutTap,
  readBrowserKey,
  signInAddress,
} from '../src/features/auth/browser-handoff'

/**
 * «Кабинет» → the phone's own browser, signed in: the pure half.
 *
 * The Android hop cannot be run here, and was not run on a device when it was
 * written. What CAN be pinned is that the link this builds survives the exact
 * two steps it meets on Android, as read from their sources — so those two
 * steps are simulated below, and the link is checked on the far side of them.
 */

const KEY = 'a1'.repeat(32)
const ORIGIN = 'https://cabinet.example'

/**
 * Telegram for Android, `Browser.openInExternalApp`: the link is rebuilt by
 * `Browser.replace` from `Uri.parse(url)` — scheme, host, port, path, the
 * query as `getQuery()` returns it and the fragment as `getFragment()` returns
 * it. Both getters DECODE, so an escaped value inside the fragment comes out
 * raw. That rebuilt string is what `Intent.parseUri` then reads.
 */
function telegramRebuild(link: string): string {
  const hashAt = link.indexOf('#')
  const beforeHash = hashAt === -1 ? link : link.slice(0, hashAt)
  const fragment = hashAt === -1 ? null : decodeURIComponent(link.slice(hashAt + 1))
  const queryAt = beforeHash.indexOf('?')
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
  const query = queryAt === -1 ? null : decodeURIComponent(beforeHash.slice(queryAt + 1))
  return `${base}${query === null ? '' : `?${query}`}${fragment === null ? '' : `#${fragment}`}`
}

/**
 * Android, `Intent.parseUri(uri, URI_INTENT_SCHEME)`, the parts this link
 * uses: the intent section is found by the LAST `#`, must start `#Intent;`,
 * is split on `;` into `key=value` pairs on the FIRST `=`, and the data URI is
 * the text before it with `intent:` replaced by the `scheme=` value.
 */
function androidParse(uri: string): { data: string; action: string | null; pkg: string | null; fallback: string | null } {
  const at = uri.lastIndexOf('#')
  if (at === -1 || !uri.startsWith('#Intent;', at)) throw new Error(`not an intent uri to Android: ${uri}`)
  const fields = new Map<string, string>()
  for (const part of uri.slice(at + '#Intent;'.length).split(';')) {
    if (part === 'end' || part === '') continue
    const eq = part.indexOf('=')
    fields.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)))
  }
  const scheme = fields.get('scheme') ?? null
  const rest = uri.slice(0, at).replace(/^intent:/, '')
  return {
    data: `${scheme}:${rest}`,
    action: fields.get('action') ?? null,
    pkg: fields.get('package') ?? null,
    fallback: fields.get('S.browser_fallback_url') ?? null,
  }
}

describe('the Android hop to the default browser', () => {
  const target = signInAddress(ORIGIN, KEY)

  it('opens exactly the sign-in address, in no browser in particular', () => {
    const intent = androidDefaultBrowserIntent(target)
    expect(intent).not.toBeNull()
    const parsed = androidParse(telegramRebuild(intent as string))
    expect(parsed.data).toBe(`${ORIGIN}/?signin=${KEY}`)
    expect(parsed.action).toBe('android.intent.action.VIEW')
    // No package: the owner asked for the DEFAULT browser, not Chrome by name.
    expect(parsed.pkg).toBeNull()
  })

  it('falls back to the same address inside Telegram should nothing take the intent', () => {
    const parsed = androidParse(telegramRebuild(androidDefaultBrowserIntent(target) as string))
    expect(parsed.fallback).toBe(`${ORIGIN}/?signin=${KEY}`)
  })

  it('carries exactly one `#`, the one Android looks for', () => {
    const intent = androidDefaultBrowserIntent(target) as string
    expect(intent.split('#')).toHaveLength(2)
    expect(telegramRebuild(intent).split('#')).toHaveLength(2)
  })

  it('refuses a target with a fragment of its own — the parse above would go to the wrong `#`', () => {
    // ANTI-VACUITY for the one above: this is the shape that broke it.
    expect(androidDefaultBrowserIntent(`${ORIGIN}/auth/open#k=${KEY}`)).toBeNull()
    const broken = `intent://cabinet.example/?signin=${KEY}#Intent;scheme=https;S.browser_fallback_url=${encodeURIComponent(`${ORIGIN}/#k=${KEY}`)};end`
    expect(() => androidParse(telegramRebuild(broken))).toThrow('not an intent uri')
  })

  it('keeps a port, and refuses anything but http(s)', () => {
    const parsed = androidParse(telegramRebuild(androidDefaultBrowserIntent(`https://cabinet.example:8443/?signin=${KEY}`) as string))
    expect(parsed.data).toBe(`https://cabinet.example:8443/?signin=${KEY}`)
    expect(androidDefaultBrowserIntent('happ://add/sub')).toBeNull()
    expect(androidDefaultBrowserIntent('not a url')).toBeNull()
  })
})

describe('which browser this is', () => {
  it('knows an Android WebView — Telegram’s in-app browser — by its own mark', () => {
    expect(
      isAndroidWebView(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36',
      ),
    ).toBe(true)
  })

  it('takes Chrome, a Custom Tab, Safari and a desktop browser for the real thing', () => {
    // ANTI-VACUITY: a sign-in in any of these persists, so none of them hops.
    for (const ua of [
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ]) {
      expect(isAndroidWebView(ua), ua).toBe(false)
    }
  })
})

describe('the key on its way', () => {
  it('travels into /auth/open in the fragment, never reaching a server log there', () => {
    expect(browserOpenUrl(ORIGIN, KEY)).toBe(`${ORIGIN}/auth/open#k=${KEY}`)
    expect(readBrowserKey(new URL(browserOpenUrl(ORIGIN, KEY)).hash)).toBe(KEY)
  })

  it('reads only a key the sign-in endpoint could ever take', () => {
    expect(readBrowserKey('')).toBeNull()
    expect(readBrowserKey('#k=short')).toBeNull()
    expect(readBrowserKey(`#k=${KEY}x`)).toBeNull()
    expect(readBrowserKey(`#other=${KEY}`)).toBeNull()
  })

  it('hands it to the home page, the one place that spends the bot’s keys', () => {
    expect(signInAddress(ORIGIN, KEY)).toBe(`${ORIGIN}/?signin=${KEY}`)
  })
})

describe('when the Mini App may open the browser without a tap', () => {
  it('only on Telegram Desktop, which asks for no gesture', () => {
    expect(opensWithoutTap('tdesktop')).toBe(true)
    for (const platform of ['android', 'ios', 'macos', 'weba', 'webk', 'unknown', null]) {
      expect(opensWithoutTap(platform), String(platform)).toBe(false)
    }
  })
})
