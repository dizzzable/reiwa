/**
 * The two answers the cabinet's FRESH session check gives before money moves
 * or a credential changes — a withdrawal, paying with the partner balance, a
 * password change, linking a Telegram or an e-mail
 * (`src/api/middleware/fresh-session-check.ts`):
 *
 *   - `unavailable` (503 `SESSION_CHECK_UNAVAILABLE`): the panel could not say
 *     whether this session was signed out elsewhere, so nothing was done. The
 *     customer is told so, and to try again in a minute — not "payment failed",
 *     which sends them looking for a problem with their money.
 *   - `revoked` (401 `SESSION_REVOKED`): this session was signed out elsewhere
 *     («Выйти на всех устройствах», a new password) and has just ended. Outside
 *     the auth routes the transport already sends the browser to sign-in; a
 *     page calling an auth route has to do it itself (`leaveForSignIn`).
 *
 * `null` for every other error: the page keeps its own reading of it.
 */
export type SessionCheckRefusal = 'unavailable' | 'revoked'

export function readSessionCheckRefusal(err: unknown): SessionCheckRefusal | null {
  if (typeof err !== 'object' || err === null) return null
  const response = (err as { response?: { status?: unknown; data?: unknown } }).response
  const data = response?.data
  const code = typeof data === 'object' && data !== null ? (data as { code?: unknown }).code : undefined
  if (response?.status === 503 && code === 'SESSION_CHECK_UNAVAILABLE') return 'unavailable'
  if (response?.status === 401 && code === 'SESSION_REVOKED') return 'revoked'
  return null
}
