/**
 * Password recovery — the cabinet side of "forgot password".
 *
 * Plain functions over the shared transport, deliberately NOT wrapped in
 * React Query mutations by the pages that call them: a mutation keeps its
 * variables in the query client's cache, and one of these carries a new
 * password (as the same SHA-256 the registration form sends) — which must
 * live in the page's memory and nowhere else.
 */
import { apiClient } from '@/lib/api-client/transport'

/**
 * The answer "forgot password" gives. `accepted` is the same for every login —
 * existing or not, linked or not — so the page cannot show anything that
 * depends on the account. `unavailable` means the panel does not send reset
 * links at all (an older panel), which is also the same for everybody.
 */
export interface RecoverAnswer {
  readonly status: 'accepted' | 'unavailable'
}

export const requestPasswordReset = (identifier: string) =>
  apiClient.post<RecoverAnswer>('/auth/recover', { username: identifier }).then((r) => r.data)

export type ResetLinkState =
  | { readonly status: 'valid'; readonly login: string; readonly expiresAt: string }
  | { readonly status: 'expired' | 'used' }

export const inspectResetLink = (token: string) =>
  apiClient.post<ResetLinkState>('/auth/reset-password/inspect', { token }).then((r) => r.data)

export interface ResetPasswordAnswer {
  readonly success: true
  readonly redirectUrl: string
  readonly login: string
}

/** `passwordHash` is `hashPassword(newPassword)` — the same digest registration sends. */
export const resetPassword = (token: string, passwordHash: string) =>
  apiClient
    .post<ResetPasswordAnswer>('/auth/reset-password', { token, passwordHash })
    .then((r) => r.data)

/**
 * `verified`: an account with no other way in; the token continues on
 * `/reset-password`. `accepted`: the "forgot password" form's one answer — the
 * account has Telegram or a verified e-mail, so the subscription link was not
 * the proof and the ordinary reset link went there instead.
 */
export type SubscriptionRecoveryAnswer =
  | {
      readonly status: 'verified'
      readonly token: string
      readonly login: string
      readonly expiresAt: string
    }
  | { readonly status: 'accepted' }

export const recoverBySubscription = (link: string, login: string) =>
  apiClient
    .post<SubscriptionRecoveryAnswer>('/auth/recover/subscription', { link, username: login })
    .then((r) => r.data)

/**
 * How the subscription page hands a reset token to `/reset-password`: in the
 * router's navigation state, which the reset page reads once and then erases
 * — never in the address, where it would stay in history and could leave in a
 * Referer.
 */
export interface ResetHandoffState {
  readonly resetToken: string
  readonly login: string
}

export function readResetHandoff(state: unknown): ResetHandoffState | null {
  if (typeof state !== 'object' || state === null) return null
  const { resetToken, login } = state as { resetToken?: unknown; login?: unknown }
  if (typeof resetToken !== 'string' || !/^[a-f0-9]{64}$/.test(resetToken)) return null
  return { resetToken, login: typeof login === 'string' ? login : '' }
}

const RESET_TOKEN_SHAPE = /^[a-f0-9]{64}$/

/**
 * A reset token in the fragment, `#token=` — the links in e-mail and behind
 * the bot's URL button. A browser never sends a fragment to any server, so it
 * lands in no access log and leaves in no Referer.
 */
export function readResetTokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token')
  return token !== null && RESET_TOKEN_SHAPE.test(token) ? token : null
}

/**
 * A reset token in `?token=` — only the Mini App fallback uses it, because
 * Telegram appends its launch parameters to a Mini App's fragment.
 */
export function readResetTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('token')
  return token !== null && RESET_TOKEN_SHAPE.test(token) ? token : null
}

/**
 * The login a page hands to `/sign-in` in navigation state, to be typed in
 * already — after a reset whose sign-in did not go through, the customer may
 * not remember it.
 */
export interface SignInHandoffState {
  readonly login: string
}

export function readSignInHandoff(state: unknown): string {
  if (typeof state !== 'object' || state === null) return ''
  const { login } = state as { login?: unknown }
  return typeof login === 'string' && login.length <= 64 ? login.trim() : ''
}
