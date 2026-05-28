/**
 * User namespace — bootstrap / session / language / rules acceptance
 * and the side-channel endpoints under `/user/session/*` (web-account
 * link prompt snooze, email-verification challenge etc.).
 *
 * `bootstrap()` is the gate the bot walks every user through on
 * `/start`: any other namespace assumes the user already exists in
 * rezeis-admin's DB.
 */
import type { AdminTransport } from '../transport.js';

export interface BootstrapUserInput {
  readonly telegramId: string;
  readonly username?: string;
  readonly name: string;
  readonly language?: string;
}

export class UserNamespace {
  constructor(private readonly transport: AdminTransport) {}

  bootstrap(data: BootstrapUserInput): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/user/bootstrap', data);
  }

  getSession(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/session?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  updateLanguage(telegramId: string, language: string): Promise<unknown> {
    return this.transport.request('PATCH', '/api/internal/user/language', { telegramId, language });
  }

  acceptRules(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      `/api/internal/user/session/rules-acceptance?telegramId=${encodeURIComponent(telegramId)}`,
      {},
    );
  }

  changeWebAccountPassword(telegramId: string, newPassword: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      '/api/internal/user/session/web-account-password',
      { userId: telegramId, password: newPassword },
    );
  }

  snoozeWebAccountLinkPrompt(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      `/api/internal/user/session/web-account-link-prompt-snooze?telegramId=${encodeURIComponent(telegramId)}`,
      {},
    );
  }

  /**
   * The `_email` parameter is intentionally ignored — the upstream
   * resolves the verification target from the user's stored web account.
   * Kept in the signature so call sites that already pass an email
   * value don't need to be touched in Wave 2.
   */
  issueEmailVerificationChallenge(telegramId: string, _email: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      '/api/internal/user/session/web-account-email-verification-challenge',
      { userId: telegramId },
    );
  }

  completeEmailVerification(telegramId: string, code: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      '/api/internal/user/session/web-account-email-verification-completion',
      { userId: telegramId, code },
    );
  }

  /**
   * Idempotently set `User.isBotBlocked = true` for the given Telegram
   * id. Called by reiwa-bot when Telegram returns 403 on a `/notify`
   * delivery — the user has either blocked the bot or removed it from
   * the chat. Persisting the flag stops admin from continuing to push
   * notifications and excludes the user from broadcast targeting.
   */
  markBotBlocked(telegramId: string): Promise<{ ok: true }> {
    return this.transport.request<{ ok: true }>(
      'POST',
      '/api/internal/user/bot-blocked',
      { telegramId },
    );
  }
}
