/**
 * The Telegram account a Mini App launch names — READ, NOT VERIFIED.
 *
 * Telegram keeps several accounts in one app, and they share ONE cookie store.
 * The cabinet signs in from that cookie whenever it has one and reads the
 * launch data only when it has none (`stealth-layout.tsx`,
 * `tma-bootstrap-page.tsx`) — so account B opening the Mini App on a phone where
 * account A signed in earlier used to land in A's cabinet, silently.
 *
 * What is read here serves one thing only: NOTICING that the session is
 * another Telegram account than the launch. The app then signs in as the
 * launch's account (`LaunchAccountGate`) through `/auth/telegram/bootstrap`,
 * which checks the bot token's HMAC before it signs anybody in. Never an
 * identity, never an authorisation.
 *
 * Switched, not asked — the owner's decision (23.09.2026): the account that
 * opened the app is the account shown. But only inside a Telegram client's
 * webview (`isTelegramWebview`): launch data can also arrive in a crafted link,
 * and followed in a browser it would move a signed-in customer into whoever
 * made the link.
 */

import { isAndroidWebView } from './browser-handoff'

export interface LaunchAccount {
  /** The Telegram user id, as a string — the shape the session carries it in. */
  readonly id: string
  /** A first name, else an @username, for a button; `null` when there is neither. */
  readonly label: string | null
}

/** The account the launch data names, or `null` for no launch data or none readable. */
export function readLaunchAccount(initData: string | null): LaunchAccount | null {
  if (initData === null) return null
  try {
    const raw = new URLSearchParams(initData).get('user')
    if (raw === null) return null
    const user = JSON.parse(raw) as { id?: unknown; first_name?: unknown; username?: unknown }
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return null
    const first = typeof user.first_name === 'string' ? user.first_name.trim() : ''
    const username = typeof user.username === 'string' ? user.username.trim() : ''
    const label = first.length > 0 ? first : username.length > 0 ? `@${username}` : null
    return { id: String(user.id), label }
  } catch {
    return null
  }
}

/**
 * Whether this session is ANOTHER Telegram account than the launch's.
 *
 * Only when both are Telegram accounts. A website account with no Telegram is
 * left alone: it may well be the same person, who links the two through the
 * claim flow, and asking them to pick would break nothing but their way in.
 */
export function isOtherTelegramAccount(
  sessionTelegramId: string | null | undefined,
  launch: LaunchAccount | null,
): boolean {
  if (launch === null) return false
  const own = sessionTelegramId == null ? '' : String(sessionTelegramId).trim()
  return own.length > 0 && own !== launch.id
}

/**
 * Whether this document runs in a Telegram client's own webview — the only
 * place a launch's account may take over the session.
 *
 * NOT `isTelegramMiniAppSurface()`: that answers from the launch parameters in
 * the URL, and a link carries those anywhere. A crafted link with somebody
 * else's signed payload, opened in a browser where a customer is signed in, is
 * exactly what must not switch accounts. What a link cannot bring with it:
 *   - `window.TelegramWebviewProxy`, which Telegram for iOS and Telegram
 *     Desktop (Windows, macOS) inject into the Mini App;
 *   - an Android WebView. Telegram for Android defines its bridge from a
 *     document-start script only where the WebView supports one, and later
 *     where it does not, so the bridge alone would miss Mini Apps there.
 * Telegram Web and Desktop for Linux frame the Mini App cross-site, where the
 * SameSite=Lax session cookie is neither sent nor set: there is no session to
 * take over.
 *
 * What this cannot tell apart is Telegram for Android's in-app browser, which
 * has the same bridge and shares the Mini App's cookie store: a crafted link
 * opened from a chat there does switch. Accepted with the decision above.
 */
export function isTelegramWebview(): boolean {
  if (typeof window === 'undefined') return false
  if (window.TelegramWebviewProxy !== undefined) return true
  return typeof navigator !== 'undefined' && isAndroidWebView(navigator.userAgent)
}
