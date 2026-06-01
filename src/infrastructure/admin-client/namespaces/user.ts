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

/**
 * Caller identity for user-scoped reads/writes. Exactly one of
 * `userId` (reiwa_id CUID — works for web-first users with no Telegram)
 * or `telegramId` is used; `userId` wins when both are present. rezeis'
 * internal endpoints accept either.
 */
export interface UserIdentity {
  readonly userId?: string;
  readonly telegramId?: string;
}

/**
 * Build the `?userId=…` / `?telegramId=…` query string for the rezeis
 * internal user endpoints from a polymorphic identity. Prefers reiwa_id.
 */
function identityQuery(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return `userId=${encodeURIComponent(identity.userId)}`;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return `telegramId=${encodeURIComponent(identity.telegramId)}`;
  }
  throw new Error('UserNamespace: a userId or telegramId is required');
}

/** Body identity fields for PATCH/POST endpoints (rezeis accepts either). */
function identityBody(identity: UserIdentity): Record<string, string> {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return { userId: identity.userId };
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return { telegramId: identity.telegramId };
  }
  throw new Error('UserNamespace: a userId or telegramId is required');
}

export class UserNamespace {
  constructor(private readonly transport: AdminTransport) {}

  bootstrap(data: BootstrapUserInput): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/user/bootstrap', data);
  }

  getSession(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/session?${identityQuery(identity)}`,
    );
  }

  updateLanguage(identity: UserIdentity, language: string): Promise<unknown> {
    return this.transport.request('PATCH', '/api/internal/user/language', {
      ...identityBody(identity),
      language,
    });
  }

  acceptRules(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      `/api/internal/user/session/rules-acceptance?${identityQuery(identity)}`,
      {},
    );
  }

  setOnboarding(identity: UserIdentity, completed: boolean): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      `/api/internal/user/session/onboarding?${identityQuery(identity)}`,
      { completed },
    );
  }

  changeWebAccountPassword(identity: UserIdentity, newPassword: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      '/api/internal/user/session/web-account-password',
      { ...identityBody(identity), password: newPassword },
    );
  }

  snoozeWebAccountLinkPrompt(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      `/api/internal/user/session/web-account-link-prompt-snooze?${identityQuery(identity)}`,
      {},
    );
  }

  /**
   * The `_email` parameter is intentionally ignored — the upstream
   * resolves the verification target from the user's stored web account.
   * Kept in the signature so call sites that already pass an email
   * value don't need to be touched in Wave 2.
   */
  issueEmailVerificationChallenge(identity: UserIdentity, _email: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      '/api/internal/user/session/web-account-email-verification-challenge',
      { ...identityBody(identity) },
    );
  }

  completeEmailVerification(identity: UserIdentity, code: string): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      '/api/internal/user/session/web-account-email-verification-completion',
      { ...identityBody(identity), code },
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
