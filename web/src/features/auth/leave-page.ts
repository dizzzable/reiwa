/**
 * The ways a page leaves itself, in a module of their own so a test can watch
 * them: jsdom implements none of them, and `window.location` cannot be stubbed
 * in place.
 */

/** Replaces this page in the tab's history — the sign-in address must not stay behind it. */
export function replacePage(url: string): void {
  window.location.replace(url)
}

/**
 * Follows a link as a navigation would. For `intent://` inside Telegram's
 * in-app browser this never loads anything: Telegram's own handler hands it to
 * the system before the web view goes anywhere.
 */
export function followLink(url: string): void {
  window.location.href = url
}

/**
 * The same address in a fresh document: nothing the previous one held
 * survives — the query cache, a live-updates stream, the channel gate's
 * verdict. `LaunchAccountSwitch` needs exactly that after it changes accounts.
 */
export function reloadPage(): void {
  window.location.reload()
}
