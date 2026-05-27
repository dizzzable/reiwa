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
      },
    );
  }

  login(login: string, password: string): Promise<WebAuthLoginResult> {
    return this.transport.request<WebAuthLoginResult>(
      'POST',
      '/api/internal/web-auth/login',
      { login, password },
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
}
