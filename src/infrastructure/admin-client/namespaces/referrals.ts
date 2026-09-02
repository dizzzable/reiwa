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
  readonly idempotencyKey?: string;
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

  /**
   * Paginated list of users this user has invited (newest first). Each
   * entry has a display label, qualified flag and invite timestamp.
   */
  getInvitedUsers(identity: UserIdentity, page = 1, limit = 20): Promise<unknown> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/invited?${params.toString()}`,
    );
  }

  /**
   * Keyset-paginated points ledger (newest first). `cursor` is the opaque
   * `nextCursor` from the previous page — it is only sent when non-empty,
   * because an empty `cursor=` on the wire is NOT the same as "start from
   * the top" upstream and would page from nowhere.
   *
   * A panel older than this route answers 404; the caller turns that into
   * the "no points history here" signal rather than a failure.
   */
  getPointsLedger(
    identity: UserIdentity,
    cursor?: string | null,
    limit = 20,
  ): Promise<unknown> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (typeof cursor === 'string' && cursor.length > 0) {
      params.set('cursor', cursor);
    }
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/referrals/points/ledger?${params.toString()}`,
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
        ...(data.idempotencyKey !== undefined
          ? { idempotencyKey: data.idempotencyKey }
          : {}),
      },
    );
  }
}
