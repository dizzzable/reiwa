/**
 * Web-auth namespace — registration, login, recovery and password
 * change for the SPA. Replaces the legacy
 * `signInWebAccount` / `initiatePasswordRecovery` /
 * `resetPasswordByLink` trio (all kept as deprecated shims on the
 * facade for old SPA bundles still in service-worker cache).
 */
import type { AdminTransport } from '../transport.js';

export interface WebAuthRegisterOptions {
  readonly email?: string;
  readonly telegramIdToLink?: string;
  /** Referral code from the invite link (`/register?ref=<code>`). */
  readonly referralCode?: string;
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

export interface WebAuthBotSigninIssueResult {
  readonly token: string | null;
  readonly expiresAt: string | null;
}

export interface WebAuthBotSigninConsumeResult {
  readonly userId: string | null;
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

  recover(login: string): Promise<WebAuthRecoverResult> {
    return this.transport.request<WebAuthRecoverResult>(
      'POST',
      '/api/internal/web-auth/recover',
      { login },
    );
  }

  changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean }> {
    return this.transport.request<{ success: boolean }>(
      'POST',
      '/api/internal/web-auth/change-password',
      { userId, currentPassword, newPassword },
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
