import { isSigninTokenShape, SIGNIN_TOKEN_PARAM } from '@/lib/magic-link'

/**
 * «Кабинет» in the bot → the cabinet in the phone's own browser, signed in.
 *
 * ── The way out, per platform ───────────────────────────────────────────────
 *
 * The bot button opens the Mini App (`/open-in-browser`); a tap there hands
 * `openLink` this cabinet's `/auth/open`, carrying a one-time key. Where
 * `openLink` lands was read out of the clients' sources when the connect
 * trampoline was built (`features/connect/deep-link-handoff.ts`): iOS → Safari,
 * Telegram Desktop → the system's default browser, the web clients → a new tab,
 * Android → USUALLY TELEGRAM'S OWN IN-APP BROWSER, which is a WebView.
 *
 * From that WebView one more hop reaches the default browser, and it is not a
 * guess: Telegram for Android (`BotWebViewContainer.shouldOverrideUrlLoading`,
 * a non-bot web view) hands any `intent://` link to `Browser.openInExternalApp`
 * with intents allowed, which parses it and calls `startActivity` WITHOUT the
 * «non-browser apps only» flag it puts on ordinary links — so a VIEW intent for
 * an https address resolves to whatever browser the owner of the phone chose
 * (read from DrKLO/Telegram master, 22.09.2026). Not Chrome by name: the
 * owner asked for the default browser, and the intent carries no package.
 *
 * ── Why the key moves from the fragment to the query on the way ────────────
 *
 * Into `/auth/open` it travels in the fragment, which never reaches a server
 * log. The Android hop cannot keep it there: Android's `Intent.parseUri` finds
 * the intent's own section by the LAST `#` in the link, so a second `#` inside
 * it breaks the parse. From `/auth/open` on it is `?signin=` — exactly what the
 * bot's links have always carried to the home page, which spends it on arrival
 * — and a spent key in a log signs nobody in.
 */

/** The fragment key `/auth/open` reads its one-time key from. */
export const BROWSER_KEY_FRAGMENT = 'k'

/** How long a key is used before the Mini App asks for a fresh one. The panel issues them for five minutes. */
export const BROWSER_KEY_REFRESH_MS = 4 * 60 * 1000

/** `/auth/open` with the key in its fragment: what the Mini App hands `openLink`. */
export function browserOpenUrl(origin: string, key: string): string {
  return `${origin}/auth/open#${BROWSER_KEY_FRAGMENT}=${encodeURIComponent(key)}`
}

/** The key `/auth/open` was opened with, or `null` for none or for anything the sign-in endpoint could never take. */
export function readBrowserKey(hash: string): string | null {
  const key = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get(BROWSER_KEY_FRAGMENT)
  return isSigninTokenShape(key) ? key : null
}

/** The home page with the key — the one place that has always spent the bot's sign-in keys. */
export function signInAddress(origin: string, key: string): string {
  const target = new URL('/', origin)
  target.searchParams.set(SIGNIN_TOKEN_PARAM, key)
  return target.toString()
}

/**
 * An Android WebView — Telegram's in-app browser among them. The `; wv)` token
 * is Android WebView's own mark in its user agent; Chrome and a Custom Tab
 * (which shares Chrome's cookies, so a sign-in there persists) never carry it.
 */
export function isAndroidWebView(userAgent: string): boolean {
  return /\bAndroid\b/.test(userAgent) && /;\s*wv\)/.test(userAgent)
}

/**
 * `intent://` that opens `target` in the phone's DEFAULT browser, with
 * `target` itself as the fallback should nothing take the intent — then the
 * in-app browser opens it where it is, and the customer is signed in there
 * rather than stranded.
 *
 * `null` when `target` is not an http(s) address without a fragment: a `#`
 * inside the link breaks `Intent.parseUri` (see the file header), and an
 * `intent://` for any other scheme is not what this builds.
 */
export function androidDefaultBrowserIntent(target: string): string | null {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hash !== '' || target.includes('#')) return null
  const scheme = url.protocol.slice(0, -1)
  return (
    `intent://${url.host}${url.pathname}${url.search}` +
    `#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;` +
    `S.browser_fallback_url=${encodeURIComponent(url.toString())};end`
  )
}

/**
 * Whether the Mini App may open the browser without waiting for a tap.
 *
 * Only Telegram Desktop: it asks for no gesture (`allowOpenLink()` returns
 * true) and hands the address to the system browser. The mobile clients and
 * Telegram for macOS carry out `web_app_open_link` only after a physical tap,
 * and the web clients open a window from a parent frame a popup blocker is
 * entitled to stop — so there the tap is the customer's.
 */
export function opensWithoutTap(platform: string | null): boolean {
  return platform === 'tdesktop'
}

/**
 * The name the launch data gives its user, for a BUTTON LABEL only.
 *
 * Unverified — the payload is read, not checked. That is fine for a label and
 * for nothing else: the account switch it offers goes through
 * `/auth/telegram/bootstrap`, which checks the bot token's HMAC before it signs
 * anybody in. `null` when there is no readable name.
 */
export function launchUserLabel(initData: string | null): string | null {
  if (initData === null) return null
  try {
    const raw = new URLSearchParams(initData).get('user')
    if (raw === null) return null
    const user = JSON.parse(raw) as { first_name?: unknown; username?: unknown }
    const first = typeof user.first_name === 'string' ? user.first_name.trim() : ''
    if (first.length > 0) return first
    const username = typeof user.username === 'string' ? user.username.trim() : ''
    return username.length > 0 ? `@${username}` : null
  } catch {
    return null
  }
}
