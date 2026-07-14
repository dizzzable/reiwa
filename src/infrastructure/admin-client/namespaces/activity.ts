/**
 * Activity namespace — transactions ledger + notification inbox (list,
 * unread count, mark-one-read, mark-all-read). The bot dashboard and
 * the SPA notifications drawer both consume from here.
 *
 * Identity: accepts a `UserIdentity` ({ userId?, telegramId? }). The
 * upstream resolves either to the canonical reiwa_id, so web-only users
 * (no Telegram) get their feeds too.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

export interface AddOnEntitlementActivityItem {
  readonly id: string;
  readonly subscriptionId: string;
  readonly addOnId: string | null;
  readonly receiptName: string;
  readonly type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  readonly valuePerUnit: number;
  readonly quantity: number;
  readonly lifetime: 'UNTIL_NEXT_RESET' | 'UNTIL_SUBSCRIPTION_END';
  readonly state: string;
  readonly currency: string;
  readonly totalAmount: string;
  readonly purchasedAt: string;
  readonly activatedAt: string | null;
  readonly expiresAt: string | null;
}

export interface AddOnEntitlementsResponse {
  readonly entitlements: readonly AddOnEntitlementActivityItem[];
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

function identityBody(identity: UserIdentity): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    body['userId'] = identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    body['telegramId'] = identity.telegramId;
  }
  return body;
}

export class ActivityNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getTransactions(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/transactions?${identityQuery(identity)}`,
    );
  }

  getAddOnEntitlements(identity: UserIdentity): Promise<AddOnEntitlementsResponse> {
    return this.transport.request<AddOnEntitlementsResponse>(
      'GET',
      `/api/internal/user/add-on-entitlements?${identityQuery(identity)}`,
    );
  }

  getNotifications(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/notifications?${identityQuery(identity)}`,
    );
  }

  getUnreadCount(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/notifications/unread-count?${identityQuery(identity)}`,
    );
  }

  markAllRead(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'POST',
      '/api/internal/user/notifications/read-all',
      identityBody(identity),
    );
  }

  markRead(identity: UserIdentity, notificationId: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/notifications/${encodeURIComponent(notificationId)}/read`,
      identityBody(identity),
    );
  }
}
