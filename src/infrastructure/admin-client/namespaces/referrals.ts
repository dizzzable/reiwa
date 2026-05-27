/**
 * Referrals namespace — invite link generation, summary stats, reward
 * ledger, invite-capacity probe, invite revocation and the
 * points-for-gift-promo exchange.
 *
 * The upstream paths are templated on `telegramId` rather than query
 * string (legacy convention; mirrored here as-is).
 */
import type { AdminTransport } from '../transport.js';

export interface ExchangePointsInput {
  readonly points: number;
}

export class ReferralsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getSummary(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${telegramId}/referrals/summary`,
    );
  }

  createInvite(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${telegramId}/referrals/invite`,
      {},
    );
  }

  getRewards(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${telegramId}/referrals/rewards`,
    );
  }

  getInviteCapacity(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(telegramId)}/referrals/invite-capacity`,
    );
  }

  revokeInvite(telegramId: string, inviteId: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(telegramId)}/referrals/invites/${encodeURIComponent(inviteId)}/revoke`,
      {},
    );
  }

  exchangePointsForGiftPromocode(telegramId: string, data: ExchangePointsInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(telegramId)}/referrals/exchange`,
      { type: 'GIFT_PROMOCODE', points: data.points },
    );
  }
}
