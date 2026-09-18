/**
 * Web-auth namespace — registration, login, recovery and password
 * change for the SPA. Replaces the legacy
 * `signInWebAccount` / `initiatePasswordRecovery` /
 * `resetPasswordByLink` trio (all kept as deprecated shims on the
 * facade for old SPA bundles still in service-worker cache).
 */
import type { AdminTransport } from '../transport.js';
import type { LegalDocumentKey } from './legal-documents.js';

export interface RegistrationSnapshotOptions {
  readonly channel?: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly referer?: string | null;
  readonly utm?: {
    readonly source?: string;
    readonly medium?: string;
    readonly campaign?: string;
    readonly content?: string;
    readonly term?: string;
    readonly raw?: string;
  } | null;
}

export interface WebAuthRegisterOptions {
  readonly email?: string;
  readonly telegramIdToLink?: string;
  /** Referral code from the invite link (`/register?ref=<code>`). */
  readonly referralCode?: string;
  /** Write-once network snapshot filled by the BFF (IP/UA/Referer/UTM). */
  readonly registrationSnapshot?: RegistrationSnapshotOptions;
  /**
   * Legal documents the applicant ticked. Travels with the registration
   * itself so the panel can refuse BEFORE creating anything — there is no
   * "created but not consented" state to clean up afterwards.
   */
  readonly acceptedLegalDocuments?: readonly LegalDocumentKey[];
}

export interface WebAuthRegisterResult {
  readonly userId: string;
  readonly webAccountId: string;
}

export interface WebAuthLoginResult {
  readonly userId: string;
  readonly requiresPasswordChange: boolean;
  readonly telegramLinked: boolean;
  readonly emailVerified: boolean;
}

export interface WebAuthRecoverResult {
  readonly method: 'telegram' | 'email' | 'none';
  readonly challengeId?: string;
}

/**
 * `POST /api/internal/web-auth/password-reset/request`. `resetLinks` is
 * constant on every answer of a panel that sends reset links; its absence
 * (an older panel) is the only thing the cabinet reads here. `method` is
 * NEVER shown to the visitor — it would tell them whether the login exists.
 */
export interface PasswordResetRequestResult {
  readonly method: 'telegram' | 'email' | 'none';
  readonly resetLinks?: true;
}

export type PasswordResetInspectResult =
  | { readonly status: 'valid'; readonly login: string; readonly expiresAt: string }
  | { readonly status: 'expired' | 'used' };

/**
 * `ok.sessionsRevokedAt`: every session of the account that started before
 * this instant is signed out; the session opened for this browser counts from
 * it. Absent from a panel older than the sign-out: nothing was revoked.
 */
export type PasswordResetConsumeResult =
  | {
      readonly status: 'ok';
      readonly userId: string;
      readonly login: string;
      readonly sessionsRevokedAt?: string;
    }
  | { readonly status: 'expired' | 'used' };

/** As for a reset: `sessionsRevokedAt` is absent from a panel older than the sign-out. */
export interface WebAuthChangePasswordResult {
  readonly success: boolean;
  readonly sessionsRevokedAt?: string;
}

/** `null`: nothing was ever revoked for this customer (or they have no web account). */
export interface WebSessionsStateResult {
  readonly sessionsRevokedAt: string | null;
}

export interface WebSessionsRevokeResult {
  readonly sessionsRevokedAt: string;
}

export interface WebPasswordStateResult {
  readonly hasPassword: boolean;
  readonly login: string | null;
}

/**
 * `set`: the first password is stored; `has_password`: the account has one
 * (perhaps set a moment ago), nothing was written; `no_account`: no usable web
 * account.
 */
export type WebFirstPasswordResult =
  | { readonly status: 'set'; readonly login: string; readonly sessionsRevokedAt: string }
  | { readonly status: 'has_password' | 'no_account' };

/**
 * `recently_sent`: a link went out within the last minute. `hourly_limit`: the
 * hour's five links already went out. `unavailable`: the panel could not store
 * or count anything. Each is a different sentence to the customer.
 */
export type PasswordResetTelegramResult =
  | {
      readonly status: 'issued';
      readonly token: string;
      readonly login: string;
      readonly expiresAt: string;
    }
  | { readonly status: 'no_account' | 'recently_sent' | 'hourly_limit' | 'unavailable' };

/**
 * `verified`: an account with no other way in — the token continues on the
 * reset page. `sent_to_channels`: the account has Telegram or a verified
 * e-mail, and the ordinary reset link went there; the visitor is shown the
 * answer "forgot password" gives everybody. `mismatch`: every failed check.
 */
export type PasswordResetSubscriptionResult =
  | {
      readonly status: 'verified';
      readonly token: string;
      readonly login: string;
      readonly expiresAt: string;
    }
  | { readonly status: 'sent_to_channels' }
  | { readonly status: 'mismatch' }
  /** The operator switched the path off; answered before any lookup. */
  | { readonly status: 'disabled' }
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly status: 'unavailable' };

/**
 * `POST /api/internal/web-auth/password-reset/first-password` — asked after a
 * refused sign-in. `sent`: the ordinary reset link went to `channel` (now or
 * within the minute); `hourly_limit`: the hour's links already went;
 * `use_bot`: Telegram is linked but the panel cannot reach the bot;
 * `unavailable`: nothing could be sent; `not_applicable`: not an account
 * without a password — the sign-in form shows its ordinary refusal.
 */
export type PasswordResetFirstPasswordResult =
  | { readonly status: 'sent'; readonly channel: 'telegram' | 'email' }
  | { readonly status: 'hourly_limit' | 'use_bot' | 'unavailable' | 'not_applicable' };

export interface WebAuthBotSigninIssueResult {
  readonly token: string | null;
  readonly expiresAt: string | null;
}

export interface WebAuthBotSigninConsumeResult {
  readonly userId: string | null;
}

export type WebAuthTelegramClaimStatus =
  | 'linked'
  | 'already_linked'
  | 'needs_admin_merge'
  | 'web_account_has_other_telegram';

export interface WebAuthTelegramClaimResult {
  readonly status: WebAuthTelegramClaimStatus;
  readonly userId?: string;
}

export class WebAuthNamespace {
  constructor(private readonly transport: AdminTransport) {}

  register(
    login: string,
    password: string,
    options?: WebAuthRegisterOptions,
  ): Promise<WebAuthRegisterResult> {
    return this.transport.request<WebAuthRegisterResult>(
      'POST',
      '/api/internal/web-auth/register',
      {
        login,
        password,
        email: options?.email,
        telegramIdToLink: options?.telegramIdToLink,
        referralCode: options?.referralCode,
        registrationSnapshot: options?.registrationSnapshot,
        acceptedLegalDocuments: options?.acceptedLegalDocuments,
      },
    );
  }

  /**
   * Claim: attach a `WebAccount` (login + password) to an ALREADY-EXISTING
   * `User` identified by its canonical reiwa_id. Used by the mandatory
   * first-entry onboarding for Telegram-first users (a `User` exists but no
   * `WebAccount`). The caller MUST pass the userId resolved from the
   * authenticated WebSession, so it can only ever attach credentials to the
   * caller's own account. 409 on existing web account / taken login.
   */
  claim(userId: string, login: string, password: string): Promise<WebAuthRegisterResult> {
    return this.transport.request<WebAuthRegisterResult>(
      'POST',
      '/api/internal/web-auth/claim',
      { userId, login, password },
    );
  }

  login(login: string, password: string): Promise<WebAuthLoginResult> {
    return this.transport.request<WebAuthLoginResult>(
      'POST',
      '/api/internal/web-auth/login',
      { login, password },
    );
  }

  /**
   * Self-service Telegram link: bind the caller's (BFF-proven) Telegram id to
   * an EXISTING web account identified by login + password. The reiwa BFF
   * passes the `telegramId` it validated from `initData` — never a client body.
   * Returns a typed status: `linked` / `already_linked` carry the `userId` the
   * BFF re-mints a WebSession for; `needs_admin_merge` /
   * `web_account_has_other_telegram` are refusals surfaced to the user.
   */
  telegramClaim(
    telegramId: string,
    login: string,
    password: string,
  ): Promise<WebAuthTelegramClaimResult> {
    return this.transport.request<WebAuthTelegramClaimResult>(
      'POST',
      '/api/internal/web-auth/telegram-claim',
      { telegramId, login, password },
    );
  }

  /**
   * Non-mutating availability probe for a login. Does NOT create an
   * account or consume the registration rate limit.
   */
  checkLogin(login: string): Promise<{ available: boolean }> {
    return this.transport.request<{ available: boolean }>(
      'POST',
      '/api/internal/web-auth/check-login',
      { login },
    );
  }

  /**
   * The route the cabinet called up to 0.9.7.45. Kept for completeness; the
   * cabinet now uses `requestPasswordReset`, whose answer it never shows.
   */
  recover(login: string): Promise<WebAuthRecoverResult> {
    return this.transport.request<WebAuthRecoverResult>(
      'POST',
      '/api/internal/web-auth/recover',
      { login },
    );
  }

  /**
   * "Forgot password": the panel sends a reset link to every channel the
   * account has. `cabinetUrl` is THIS cabinet's configured public address —
   * the only host a link may point at. A panel without the route answers 404.
   */
  requestPasswordReset(identifier: string, cabinetUrl: string | null): Promise<PasswordResetRequestResult> {
    return this.transport.request<PasswordResetRequestResult>(
      'POST',
      '/api/internal/web-auth/password-reset/request',
      cabinetUrl === null ? { identifier } : { identifier, cabinetUrl },
    );
  }

  /**
   * After a refused sign-in: if the login is an account imported WITHOUT a
   * password, the panel sends its owner the ordinary reset link and says so.
   * A panel without the route answers 404 — the caller treats that as
   * `not_applicable`.
   */
  sendFirstPasswordLink(login: string, cabinetUrl: string | null): Promise<PasswordResetFirstPasswordResult> {
    return this.transport.request<PasswordResetFirstPasswordResult>(
      'POST',
      '/api/internal/web-auth/password-reset/first-password',
      cabinetUrl === null ? { login } : { login, cabinetUrl },
    );
  }

  /** Whether a reset link still works, and for which login. Spends nothing. */
  inspectPasswordReset(token: string): Promise<PasswordResetInspectResult> {
    return this.transport.request<PasswordResetInspectResult>(
      'POST',
      '/api/internal/web-auth/password-reset/inspect',
      { token },
    );
  }

  /** Spend a reset link and set the new password (the SHA-256 hex, like register). */
  consumePasswordReset(token: string, password: string): Promise<PasswordResetConsumeResult> {
    return this.transport.request<PasswordResetConsumeResult>(
      'POST',
      '/api/internal/web-auth/password-reset/consume',
      { token, password },
    );
  }

  /**
   * The bot asks for a reset link for the Telegram user it is talking to. The
   * plaintext token is in the answer; the bot must put it only behind a button
   * on its own cabinet address and never log it.
   */
  issuePasswordResetForTelegram(telegramId: string): Promise<PasswordResetTelegramResult> {
    return this.transport.request<PasswordResetTelegramResult>(
      'POST',
      '/api/internal/web-auth/password-reset/telegram',
      { telegramId },
    );
  }

  /**
   * Recovery by VPN subscription link plus login. `clientIp` feeds the panel's
   * per-address budget; `cabinetUrl` is THIS cabinet's configured address, for
   * the reset link an account with a channel is sent instead.
   */
  recoverPasswordBySubscription(input: {
    readonly link: string;
    readonly login: string;
    readonly clientIp: string | null;
    readonly cabinetUrl: string | null;
  }): Promise<PasswordResetSubscriptionResult> {
    return this.transport.request<PasswordResetSubscriptionResult>(
      'POST',
      '/api/internal/web-auth/password-reset/subscription',
      {
        link: input.link,
        login: input.login,
        ...(input.clientIp === null ? {} : { clientIp: input.clientIp }),
        ...(input.cabinetUrl === null ? {} : { cabinetUrl: input.cabinetUrl }),
      },
    );
  }

  changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<WebAuthChangePasswordResult> {
    return this.transport.request<WebAuthChangePasswordResult>(
      'POST',
      '/api/internal/web-auth/change-password',
      { userId, currentPassword, newPassword },
    );
  }

  /**
   * The moment before which every cabinet session of `userId` is signed out.
   * Asked at most once a minute per session; a panel older than the sign-out
   * answers 404.
   */
  sessionsState(userId: string): Promise<WebSessionsStateResult> {
    return this.transport.request<WebSessionsStateResult>(
      'POST',
      '/api/internal/web-auth/sessions/state',
      { userId },
    );
  }

  /** «Выйти на всех устройствах»: sign every existing session of `userId` out. */
  revokeSessions(userId: string): Promise<WebSessionsRevokeResult> {
    return this.transport.request<WebSessionsRevokeResult>(
      'POST',
      '/api/internal/web-auth/sessions/revoke',
      { userId },
    );
  }

  /** Whether the signed-in customer has a password yet (404: no web account, or an older panel). */
  passwordState(userId: string): Promise<WebPasswordStateResult> {
    return this.transport.request<WebPasswordStateResult>(
      'POST',
      '/api/internal/web-auth/password/state',
      { userId },
    );
  }

  /** A first password for an account that has none — never overwrites one. */
  setFirstPassword(userId: string, newPassword: string): Promise<WebFirstPasswordResult> {
    return this.transport.request<WebFirstPasswordResult>(
      'POST',
      '/api/internal/web-auth/password/first',
      { userId, newPassword },
    );
  }

  /**
   * Issue a one-time magic-link token for the given Telegram user.
   * The plaintext token comes back in the response and must be
   * embedded into the cabinet URL the bot serves to the user. When
   * the user can't be resolved, the response is `{ token: null,
   * expiresAt: null }` — caller falls back to a tokenless URL.
   */
  issueBotSigninToken(telegramId: string): Promise<WebAuthBotSigninIssueResult> {
    return this.transport.request<WebAuthBotSigninIssueResult>(
      'POST',
      '/api/internal/web-auth/bot-signin/issue',
      { telegramId },
    );
  }

  /**
   * Consume a magic-link token. Single-use — second call returns
   * `{ userId: null }`. Reiwa's BFF takes the resolved `userId` and
   * mints a real WebSession cookie.
   */
  consumeBotSigninToken(token: string): Promise<WebAuthBotSigninConsumeResult> {
    return this.transport.request<WebAuthBotSigninConsumeResult>(
      'POST',
      '/api/internal/web-auth/bot-signin/consume',
      { token },
    );
  }
}
