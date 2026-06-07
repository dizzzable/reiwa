/**
 * Payments namespace — gateway listing, checkout creation, status
 * polling and the webhook forwarder used by the reiwa→admin tunnel
 * for gateways that can't reach rezeis-admin directly.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

export interface CreateCheckoutOptions {
  readonly successUrl?: string | null;
  readonly failUrl?: string | null;
  readonly deviceType?: string | null;
}

export type PurchaseType = 'NEW' | 'ADDITIONAL' | 'RENEW' | 'UPGRADE';

export class PaymentsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getEnabledGateways(channel: 'WEB' | 'TMA' | 'BOT' = 'WEB'): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/payments/gateways?channel=${encodeURIComponent(channel)}`,
    );
  }

  createCheckout(
    identity: UserIdentity,
    purchaseType: PurchaseType,
    planId: string,
    durationDays: number,
    gatewayType: string,
    options: CreateCheckoutOptions & { subscriptionId?: string } = {},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      purchaseType,
      planId,
      durationDays,
      gatewayType,
    };
    if (typeof identity.userId === 'string' && identity.userId.length > 0) {
      payload['userId'] = identity.userId;
    }
    if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
      payload['telegramId'] = identity.telegramId;
    }
    if (options.subscriptionId) payload['subscriptionId'] = options.subscriptionId;
    if (options.successUrl) payload['successUrl'] = options.successUrl;
    if (options.failUrl) payload['failUrl'] = options.failUrl;
    if (options.deviceType) payload['deviceType'] = options.deviceType;
    return this.transport.request('POST', '/api/internal/payments/checkout', payload);
  }

  getStatus(paymentId: string, identity: UserIdentity = {}): Promise<unknown> {
    const query: string[] = [];
    if (typeof identity.userId === 'string' && identity.userId.length > 0) {
      query.push(`userId=${encodeURIComponent(identity.userId)}`);
    }
    if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
      query.push(`telegramId=${encodeURIComponent(identity.telegramId)}`);
    }
    const qs = query.length > 0 ? `?${query.join('&')}` : '';
    return this.transport.request(
      'GET',
      `/api/internal/payments/${encodeURIComponent(paymentId)}${qs}`,
    );
  }

  forwardWebhook(gatewayType: string, rawPayload: unknown): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/payments/webhooks/${encodeURIComponent(gatewayType)}`,
      rawPayload,
    );
  }
}
