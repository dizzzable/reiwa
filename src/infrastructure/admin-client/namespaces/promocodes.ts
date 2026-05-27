/**
 * Promocodes namespace — activation by Telegram identity, activation
 * history pagination and the eligible-subscriptions probe used by the
 * SPA promo dialog when a code is restricted to specific plans.
 */
import type { AdminTransport } from '../transport.js';

export class PromocodesNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Activate a promocode on behalf of a Telegram user. The upstream
   * controller resolves the rezeis-admin user from `telegramId` and
   * runs the activation pipeline.
   */
  activate(telegramId: string, code: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      '/api/internal/promocodes/activate-by-telegram',
      { telegramId, code },
    );
  }

  getActivations(telegramId: string, page = 1, limit = 20): Promise<unknown> {
    const offset = (page - 1) * limit;
    return this.transport.request(
      'GET',
      `/api/internal/promocodes/user/${telegramId}/activations?limit=${limit}&offset=${offset}`,
    );
  }

  getEligibleSubscriptions(userId: string, code: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/promocodes/eligible-subscriptions?userId=${encodeURIComponent(userId)}&code=${encodeURIComponent(code)}`,
      {},
    );
  }
}
