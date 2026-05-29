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
}
