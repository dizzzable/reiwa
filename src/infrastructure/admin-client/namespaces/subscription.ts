/**
 * Subscription namespace — read endpoints for the user's active
 * subscription(s), price quotes and the action policy that drives
 * the SPA "buy / extend / restart" CTA.
 */
import type { AdminTransport } from '../transport.js';

export class SubscriptionNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getActive(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/subscription?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  getAll(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/subscriptions?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  getQuote(
    telegramId: string,
    planId: number,
    durationDays: number,
    gatewayType: string,
  ): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/subscriptions/quote', {
      telegramId,
      planId,
      durationDays,
      gatewayType,
    });
  }

  getActionPolicy(telegramId: string, planId?: number): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/subscriptions/action-policy', {
      telegramId,
      planId,
    });
  }
}
