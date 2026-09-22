/**
 * What a refused `/auth/telegram/bootstrap` says to the person it refused.
 *
 * Shared by the two places that sign in from Telegram's launch data: the Mini
 * App's first launch (`tma-bootstrap-page.tsx`) and the switch to the account
 * that opened the app (`launch-account-switch.tsx`). The second showed only a
 * generic failure, so an account refused for good — registration closed, invite
 * only — was told to reopen the app, which only repeated the same refusal.
 *
 * Public users only ever see product-level copy (access mode gates) or a
 * generic "could not sign in". Operator/env diagnostics (Origin/CSRF,
 * BOT_TOKEN, REIWA_DOMAIN, token-null reasons) are never inferred client-side:
 * the BFF attaches them as `debug` only when the caller's Telegram id equals
 * `BOT_DEV_ID` (server-side check).
 */

export interface BootstrapErrorBody {
  code?: string
  message?: string
  retryAfter?: number
  /** Present only for BOT_DEV_ID — never rely on this for regular UX. */
  debug?: string
}

export interface AxiosErrorLike {
  response?: {
    status: number
    data?: BootstrapErrorBody | string
  }
  message?: string
}

export function isAxiosErrorLike(err: unknown): err is AxiosErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as AxiosErrorLike).response?.status === 'number'
  )
}

export function resolveBootstrapError(
  err: unknown,
  t: (key: string) => string,
): string {
  if (isAxiosErrorLike(err)) {
    const data = err.response?.data
    const body: BootstrapErrorBody =
      typeof data === 'string'
        ? { message: data }
        : data && typeof data === 'object'
          ? data
          : {}

    let userMsg: string
    switch (body.code) {
      case 'REGISTRATION_DISABLED':
        userMsg = t('bootstrap.registrationDisabled')
        break
      case 'INVITE_REQUIRED':
        userMsg = t('bootstrap.inviteRequired')
        break
      case 'SERVICE_RESTRICTED':
        userMsg = t('bootstrap.serviceRestricted')
        break
      default:
        // Do not forward raw server strings (Origin/CSRF, Access denied, …)
        // — they leak deployment internals to every Mini App user.
        userMsg = t('bootstrap.accessDenied')
        break
    }

    // Server only sets `debug` after verifying BOT_DEV_ID against initData.
    const debug = typeof body.debug === 'string' ? body.debug.trim() : ''
    if (debug) {
      return `${userMsg}\n\n[dev] ${debug}`
    }
    return userMsg
  }

  return t('bootstrap.loginErrorFallback')
}
