/**
 * Promocodes namespace — activation, activation-history pagination and
 * the eligible-subscriptions probe used by the SPA promo dialog when a
 * code is restricted to specific plans.
 *
 * The upstream `InternalPromocodesController` resolves the path / query
 * reference (`userRef`) to the canonical reiwa_id — it accepts either a
 * reiwa_id (CUID, web / web-first users) or a numeric telegramId. Callers
 * pass a `UserIdentity` and we forward the best available reference, so
 * users with no Telegram are fully supported.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

export class PromocodesNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Activate a promocode on behalf of a user. The upstream controller
   * resolves the rezeis-admin user from the `userRef` (reiwa_id or
   * telegramId) and runs the activation pipeline.
   */
  activate(identity: UserIdentity, code: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      '/api/internal/promocodes/activate-by-ref',
      { userRef: reference(identity), code },
    );
  }

  getActivations(identity: UserIdentity, page = 1, limit = 20): Promise<unknown> {
    const offset = (page - 1) * limit;
    return this.transport.request(
      'GET',
      `/api/internal/promocodes/user/${encodeURIComponent(reference(identity))}/activations?limit=${limit}&offset=${offset}`,
    );
  }

  getEligibleSubscriptions(identity: UserIdentity, code: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/promocodes/eligible-subscriptions?userRef=${encodeURIComponent(reference(identity))}&code=${encodeURIComponent(code)}`,
      {},
    );
  }
}
