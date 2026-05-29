/**
 * Referrals namespace — invite link generation, summary stats, reward
 * ledger, invite-capacity probe, invite revocation and the
 * points-exchange flow.
 *
 * The upstream paths are templated on a user reference (`:userRef`)
 * which the controller resolves polymorphically — it accepts either a
 * reiwa_id (CUID, web / web-first users) or a telegramId. Callers pass a
 * `UserIdentity` and we forward the best available reference.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

/**
 * Points-exchange reward kinds, mirrored from rezeis
 * `ReferralPointsExchangeService.PointsExchangeType`. Keep in sync.
 */
export type PointsExchangeType =
  | 'SUBSCRIPTION_DAYS'
  | 'GIFT_SUBSCRIPTION'
  | 'DISCOUNT'
  | 'TRAFFIC';

export interface ExchangePointsInput {
  readonly type: PointsExchangeType;
  readonly points: number;
  readonly subscriptionId?: string;
}

function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

export class ReferralsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getSummary(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/summary`,
    );
  }

  createInvite(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/invite`,
      {},
    );
  }

  getRewards(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/rewards`,
    );
  }

  getInviteCapacity(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/invite-capacity`,
    );
  }

  revokeInvite(identity: UserIdentity, inviteId: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/invites/${encodeURIComponent(inviteId)}/revoke`,
      {},
    );
  }

  /**
   * Available points-exchange options (per-type config + computed
   * values + the user's balance). Drives the exchange page UI.
   */
  getExchangeOptions(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/exchange/options`,
    );
  }

  /**
   * Execute a points exchange. `type` selects the reward kind and
   * `subscriptionId` targets the subscription for SUBSCRIPTION_DAYS /
   * TRAFFIC rewards (falls back to the user's current subscription
   * upstream when omitted).
   */
  exchangePoints(identity: UserIdentity, data: ExchangePointsInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/exchange`,
      {
        type: data.type,
        points: data.points,
        ...(data.subscriptionId !== undefined
          ? { subscriptionId: data.subscriptionId }
          : {}),
      },
    );
  }
}
