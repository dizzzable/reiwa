/**
 * The signed-in customer's password and sessions: whether the account has a
 * password yet, a first password for one that has none, and «Выйти на всех
 * устройствах».
 *
 * Plain functions over the shared transport, like `password-reset-api.ts` and
 * for its reason: a React Query mutation keeps its variables in the query
 * client's cache, and a first password (as the same SHA-256 the registration
 * form sends) must live in the page's memory and nowhere else.
 *
 * Every one of these acts on the account of the SESSION; none sends a user id.
 */
import { apiClient } from '@/lib/api-client/transport'

/**
 * `hasPassword: null` — no answer: a panel older than the question, no web
 * account, or the panel down. The password page then keeps its ordinary form.
 */
export interface PasswordState {
  readonly hasPassword: boolean | null
}

export const getPasswordState = () =>
  apiClient.get<PasswordState>('/auth/password-state').then((r) => r.data)

export const PASSWORD_STATE_QUERY_KEY = ['auth', 'password-state'] as const

/** `login` is for the «Сохраните данные для входа» screen that follows. */
export interface FirstPasswordAnswer {
  readonly success: true
  readonly login: string
}

/** Refused with 409 `PASSWORD_ALREADY_SET` when the account has one — it is never replaced. */
export const setFirstPassword = (newPasswordHash: string) =>
  apiClient.post<FirstPasswordAnswer>('/auth/first-password', { newPasswordHash }).then((r) => r.data)

/** Every other session of the account ends within a minute; this one continues. */
export const signOutOtherDevices = () =>
  apiClient.post<{ readonly success: true }>('/auth/sessions/revoke-others').then((r) => r.data)
