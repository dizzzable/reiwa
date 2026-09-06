/**
 * Subscription namespace — read endpoints for the user's active
 * subscription(s), price quotes and the action policy that drives
 * the SPA "buy / extend / restart" CTA.
 *
 * Identity: every method takes a `UserIdentity` ({ userId?, telegramId? }).
 * `userId` is the canonical reiwa_id (CUID) used by web / web-first
 * users; `telegramId` is the Telegram-only fallback. rezeis resolves
 * whichever is present, so a browser-registered user without Telegram
 * purchases through the same path.
 */
import type { AdminTransport } from '../transport.js';

export interface UserIdentity {
  readonly userId?: string | null;
  readonly telegramId?: string | null;
}

export type PurchaseType = 'NEW' | 'ADDITIONAL' | 'RENEW' | 'UPGRADE' | 'TRIAL';

/** Builds the identity fields shared by every subscription/payment call. */
function identityPayload(identity: UserIdentity): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    payload['userId'] = identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    payload['telegramId'] = identity.telegramId;
  }
  return payload;
}

function identityQuery(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return `userId=${encodeURIComponent(identity.userId)}`;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return `telegramId=${encodeURIComponent(identity.telegramId)}`;
  }
  return '';
}

/**
 * The best reference the edge has for this user: a reiwa_id when there is one,
 * otherwise the telegramId. The panel accepts either and tells them apart by
 * shape — a telegramId is digits, a reiwa_id is a CUID. Same rule as the
 * devices namespace, which addresses the panel the same path-shaped way.
 */
function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

export class SubscriptionNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getActive(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/subscription?${identityQuery(identity)}`,
    );
  }

  getAll(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/subscriptions?${identityQuery(identity)}`,
    );
  }

  /**
   * The servers this subscription can reach, for the globe.
   *
   * Path-shaped rather than query-shaped like the two above, because the panel
   * resolves `:userRef` itself and the subscription is part of the address, not
   * a filter — a user with two subscriptions reaches two different sets.
   *
   * The panel answers `{servers: [], recommendedServerId: null}` whenever it
   * cannot reach Remnawave, so there is no failure shape to handle here beyond
   * the transport's own.
   */
  listServers(identity: UserIdentity, subscriptionId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}` +
        `/subscriptions/${encodeURIComponent(subscriptionId)}/servers`,
    );
  }

  getQuote(
    identity: UserIdentity,
    purchaseType: PurchaseType,
    planId: string,
    durationDays: number,
    gatewayType: string,
    subscriptionId?: string,
  ): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/subscriptions/quote', {
      ...identityPayload(identity),
      purchaseType,
      planId,
      durationDays,
      gatewayType,
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    });
  }

  getActionPolicy(
    identity: UserIdentity,
    subscriptionId?: string,
  ): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/subscriptions/action-policy', {
      ...identityPayload(identity),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    });
  }

  /**
   * Lists the upgrade target plans for a subscription (the plans the source
   * plan can transition to). Backed by the admin UPGRADE quote with no
   * selected plan, so `availablePlans` carries the targets + their durations.
   */
  getUpgradeOptions(
    identity: UserIdentity,
    subscriptionId: string,
    gatewayType?: string,
  ): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/subscriptions/quote', {
      ...identityPayload(identity),
      purchaseType: 'UPGRADE',
      subscriptionId,
      ...(typeof gatewayType === 'string' && gatewayType.length > 0 ? { gatewayType } : {}),
    });
  }

  /**
   * Lists the user's renewable subscriptions with per-item renewal pricing.
   * Used by the renewal wizard to render the selection list (skipped when
   * exactly one renewable subscription exists). Returns the rezeis-admin
   * `RenewalOptionsInterface` shape (`items[]`, `currency`, `total`).
   */
  getRenewalOptions(
    identity: UserIdentity,
    options: {
      readonly subscriptionIds?: readonly string[];
      readonly gatewayType?: string;
      readonly channel?: string;
      readonly durations?: ReadonlyArray<{ readonly subscriptionId: string; readonly days: number }>;
      readonly plans?: ReadonlyArray<{ readonly subscriptionId: string; readonly planId: string }>;
    } = {},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = { ...identityPayload(identity) };
    if (options.subscriptionIds && options.subscriptionIds.length > 0) {
      payload['subscriptionIds'] = options.subscriptionIds;
    }
    if (typeof options.gatewayType === 'string' && options.gatewayType.length > 0) {
      payload['gatewayType'] = options.gatewayType;
    }
    if (typeof options.channel === 'string' && options.channel.length > 0) {
      payload['channel'] = options.channel;
    }
    if (options.durations && options.durations.length > 0) {
      payload['durations'] = options.durations;
    }
    if (options.plans && options.plans.length > 0) {
      payload['plans'] = options.plans;
    }
    return this.transport.request('POST', '/api/internal/subscriptions/renewal-options', payload);
  }

  /**
   * Self-service deletion of one of the user's own subscriptions. Forwards the
   * caller's identity; rezeis-admin enforces ownership, revokes the Remnawave
   * profile, and soft-deletes (status = DELETED). No refund is issued.
   */
  deleteSubscription(identity: UserIdentity, subscriptionId: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/subscriptions/delete', {
      ...identityPayload(identity),
      subscriptionId,
    });
  }
}
