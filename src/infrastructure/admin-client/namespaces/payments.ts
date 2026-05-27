/**
 * Payments namespace — gateway listing, checkout creation, status
 * polling and the webhook forwarder used by the reiwa→admin tunnel
 * for gateways that can't reach rezeis-admin directly.
 */
import type { AdminTransport } from '../transport.js';

export interface CreateCheckoutOptions {
  readonly successUrl?: string | null;
  readonly failUrl?: string | null;
}

export class PaymentsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getEnabledGateways(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/payments/gateways');
  }

  createCheckout(
    telegramId: string,
    planId: number,
    durationDays: number,
    gatewayType: string,
    options: CreateCheckoutOptions = {},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      telegramId,
      planId,
      durationDays,
      gatewayType,
    };
    if (options.successUrl) payload['successUrl'] = options.successUrl;
    if (options.failUrl) payload['failUrl'] = options.failUrl;
    return this.transport.request('POST', '/api/internal/payments/checkout', payload);
  }

  getStatus(paymentId: string): Promise<unknown> {
    return this.transport.request('GET', `/api/internal/payments/${paymentId}`);
  }

  forwardWebhook(gatewayType: string, rawPayload: unknown): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/payments/webhooks/${gatewayType}`,
      rawPayload,
    );
  }
}
