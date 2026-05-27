/**
 * Linking namespace — Telegram + email linking flows used by the SPA
 * "connect telegram", "verify email" wizards. Telegram codes are issued
 * by `link.telegram.generate` and consumed by the bot via
 * `link.telegram.consume` when the user submits `/start <code>` or
 * `/link <code>`.
 */
import type { AdminTransport } from '../transport.js';

export interface LinkTelegramGenerateResult {
  readonly code: string;
  readonly expiresAt: string;
}

export interface LinkTelegramConsumeResult {
  readonly success: boolean;
  readonly reason?: string;
  readonly userId?: string;
}

export interface LinkEmailInitiateResult {
  readonly success: boolean;
  readonly message: string;
}

export interface LinkEmailVerifyResult {
  readonly success: boolean;
  readonly verified: boolean;
}

export class LinkingNamespace {
  readonly telegram: TelegramLinking;
  readonly email: EmailLinking;

  constructor(transport: AdminTransport) {
    this.telegram = new TelegramLinking(transport);
    this.email = new EmailLinking(transport);
  }
}

class TelegramLinking {
  constructor(private readonly transport: AdminTransport) {}

  generate(userId: string): Promise<LinkTelegramGenerateResult> {
    return this.transport.request<LinkTelegramGenerateResult>(
      'POST',
      '/api/internal/link/telegram/generate',
      { userId },
    );
  }

  /**
   * Called by the reiwa bot when an incoming Telegram user submits a
   * linking code (`/start <code>` or `/link <code>`). Either attaches
   * Telegram to the existing reiwa_id behind the code, or returns a
   * structured failure (`INVALID_OR_EXPIRED_CODE`,
   * `TELEGRAM_ALREADY_LINKED`) the bot can render to the user.
   */
  consume(telegramId: string, code: string): Promise<LinkTelegramConsumeResult> {
    return this.transport.request<LinkTelegramConsumeResult>(
      'POST',
      '/api/internal/link/telegram/consume',
      { telegramId, code },
    );
  }
}

class EmailLinking {
  constructor(private readonly transport: AdminTransport) {}

  initiate(userId: string, email: string): Promise<LinkEmailInitiateResult> {
    return this.transport.request<LinkEmailInitiateResult>(
      'POST',
      '/api/internal/link/email/initiate',
      { userId, email },
    );
  }

  verify(userId: string, code: string): Promise<LinkEmailVerifyResult> {
    return this.transport.request<LinkEmailVerifyResult>(
      'POST',
      '/api/internal/link/email/verify',
      { userId, code },
    );
  }
}
