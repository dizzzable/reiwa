/**
 * The Telegram account a Mini App launch names — READ, NOT VERIFIED.
 *
 * Telegram keeps several accounts in one app, and they share ONE cookie store.
 * The cabinet signs in from that cookie whenever it has one and reads the
 * launch data only when it has none (`stealth-layout.tsx`,
 * `tma-bootstrap-page.tsx`) — so account B opening the Mini App on a phone where
 * account A signed in earlier used to land in A's cabinet, silently.
 *
 * What is read here serves two things only: NOTICING that the session is
 * another Telegram account than the launch, and a name for the buttons that
 * ask which one to use. The switch itself is `/auth/telegram/bootstrap`, which
 * checks the bot token's HMAC before it signs anybody in. Never an identity,
 * never an authorisation.
 *
 * And never a silent switch: launch data can also arrive in a crafted link,
 * and a signed payload of somebody else's in one would move a signed-in
 * visitor into that person's account. So the shell ASKS (`LaunchAccountChoice`).
 */

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

const STAY_KEY = 'reiwa_launch_account_stay'

/** The pair a «Остаться как …» answers: this launch's account over this session's. */
export function stayChoiceFor(launch: LaunchAccount, sessionTelegramId: string): string {
  return `${launch.id}>${sessionTelegramId}`
}

/**
 * The stay chosen earlier in THIS launch, if any.
 *
 * `sessionStorage`, so it lasts exactly as long as the Mini App's document —
 * the next launch asks again. Unreadable storage reads as «not chosen»; the
 * shell keeps its own copy in state, so the question is not repeated inside
 * one visit even then.
 */
export function readStayChoice(): string | null {
  try {
    return sessionStorage.getItem(STAY_KEY)
  } catch {
    return null
  }
}

/** Remembers a «Остаться как …» for the rest of this launch, and returns the pair it was for. */
export function rememberStay(launch: LaunchAccount, sessionTelegramId: string): string {
  const choice = stayChoiceFor(launch, sessionTelegramId)
  try {
    sessionStorage.setItem(STAY_KEY, choice)
  } catch {
    // Private mode and the like: the shell's state still holds it.
  }
  return choice
}
