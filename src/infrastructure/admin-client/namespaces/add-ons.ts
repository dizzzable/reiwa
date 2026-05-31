/**
 * Add-ons namespace — optional extras (extra traffic / extra devices)
 * an operator attaches to plans. Surfaced on the SPA purchase flow so
 * a user can top up a subscription beyond its base plan limits.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

export interface AddOnPrice {
  readonly id: string;
  readonly currency: string;
  readonly price: string;
}

export interface AddOn {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  readonly icon: string | null;
  readonly value: number;
  readonly isActive: boolean;
  readonly orderIndex: number;
  readonly applicablePlanIds: readonly string[];
  readonly prices: readonly AddOnPrice[];
}

export interface AddOnPurchaseInput {
  readonly identity: UserIdentity;
  readonly addOnId: string;
  readonly subscriptionId: string;
  readonly gatewayType: string;
  readonly channel?: string;
  readonly successUrl?: string | null;
  readonly failUrl?: string | null;
}

export class AddOnsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Active add-ons applicable to a given plan (empty `applicablePlanIds`
   * upstream means "all plans"). Used by the purchase flow.
   */
  listForPlan(planId: string): Promise<readonly AddOn[]> {
    return this.transport.request<readonly AddOn[]>(
      'GET',
      `/api/internal/add-ons/plan/${encodeURIComponent(planId)}`,
    );
  }

  /**
   * Creates a checkout for an extra-traffic / extra-devices top-up on an
   * existing subscription. Returns the provider checkout payload.
   */
  purchase(input: AddOnPurchaseInput): Promise<unknown> {
    const payload: Record<string, unknown> = {
      addOnId: input.addOnId,
      subscriptionId: input.subscriptionId,
      gatewayType: input.gatewayType,
    };
    if (typeof input.identity.userId === 'string' && input.identity.userId.length > 0) {
      payload['userId'] = input.identity.userId;
    }
    if (typeof input.identity.telegramId === 'string' && input.identity.telegramId.length > 0) {
      payload['telegramId'] = input.identity.telegramId;
    }
    if (input.channel) payload['channel'] = input.channel;
    if (input.successUrl) payload['successUrl'] = input.successUrl;
    if (input.failUrl) payload['failUrl'] = input.failUrl;
    return this.transport.request('POST', '/api/internal/add-ons/purchase', payload);
  }
}
