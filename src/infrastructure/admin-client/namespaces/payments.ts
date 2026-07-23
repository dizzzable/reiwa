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
  /** Local SavedPaymentMethod.id for off-session YooKassa charge. */
  readonly savedPaymentMethodId?: string | null;
  /** Per-request YooKassa bind-card intent (interactive only). */
  readonly savePaymentMethod?: boolean;
  /** Explicit consent to save card for autopay (required when save is true). */
  readonly savePaymentMethodConsent?: boolean;
}

export type PurchaseType = 'NEW' | 'ADDITIONAL' | 'RENEW' | 'UPGRADE';

export type PaymentTransactionStatus = 'PENDING' | 'COMPLETED' | 'CANCELED' | 'FAILED';

export type SubscriptionProvisioningStatus =
  | 'NOT_APPLICABLE'
  | 'FULFILLING'
  | 'PROFILE_PENDING'
  | 'READY'
  | 'FAILED';

/**
 * Exact wire shape returned by the Rezeis internal payment-status endpoint.
 * Keep decimal amounts as strings so the Reiwa proxy never loses precision.
 */
export interface PaymentStatusResponse {
  readonly paymentId: string;
  readonly status: PaymentTransactionStatus;
  readonly gatewayType: string;
  readonly purchaseType: PurchaseType;
  readonly amount: string;
  readonly currency: string;
  readonly checkoutUrl: string | null;
  readonly failureReason: string | null;
  readonly subscriptionId: string | null;
  readonly subscriptionProvisioningStatus: SubscriptionProvisioningStatus;
  readonly subscriptionProvisioningFailureCode: 'PROFILE_SYNC_FAILED' | null;
  readonly updatedAt: string;
}

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
    if (
      typeof options.savedPaymentMethodId === 'string' &&
      options.savedPaymentMethodId.length > 0
    ) {
      payload['savedPaymentMethodId'] = options.savedPaymentMethodId;
    }
    if (typeof options.savePaymentMethod === 'boolean') {
      payload['savePaymentMethod'] = options.savePaymentMethod;
    }
    if (typeof options.savePaymentMethodConsent === 'boolean') {
      payload['savePaymentMethodConsent'] = options.savePaymentMethodConsent;
    }
    return this.transport.request('POST', '/api/internal/payments/checkout', payload);
  }

  /**
   * Pay for a subscription (new / additional / renew / upgrade) with the
   * partner balance. Completes synchronously on the rezeis side (no external
   * gateway) after debiting the balance.
   */
  payWithPartnerBalance(
    identity: UserIdentity,
    input: {
      readonly purchaseType: PurchaseType;
      readonly planId: string;
      readonly durationDays: number;
      readonly subscriptionId?: string;
      readonly channel?: string;
      readonly deviceType?: string;
    },
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      purchaseType: input.purchaseType,
      planId: input.planId,
      durationDays: input.durationDays,
    };
    if (typeof identity.userId === 'string' && identity.userId.length > 0) {
      payload['userId'] = identity.userId;
    }
    if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
      payload['telegramId'] = identity.telegramId;
    }
    if (input.subscriptionId) payload['subscriptionId'] = input.subscriptionId;
    if (input.channel) payload['channel'] = input.channel;
    if (input.deviceType) payload['deviceType'] = input.deviceType;
    return this.transport.request(
      'POST',
      '/api/internal/payments/partner-balance/checkout',
      payload,
    );
  }

  getStatus(paymentId: string, identity: UserIdentity = {}): Promise<PaymentStatusResponse> {
    const query: string[] = [];
    if (typeof identity.userId === 'string' && identity.userId.length > 0) {
      query.push(`userId=${encodeURIComponent(identity.userId)}`);
    }
    if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
      query.push(`telegramId=${encodeURIComponent(identity.telegramId)}`);
    }
    const qs = query.length > 0 ? `?${query.join('&')}` : '';
    return this.transport.request<PaymentStatusResponse>(
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

  /**
   * Combined multi-subscription renewal: one provider checkout for the
   * summed total of N renewals. Each subscription renews on its original
   * (or replacement) plan and originally purchased duration on the
   * rezeis-admin side. Returns the standard checkout shape
   * (`paymentId`, `checkoutUrl`, ...).
   */
  createRenewalCheckout(
    identity: UserIdentity,
    input: {
      readonly subscriptionIds: readonly string[];
      readonly gatewayType: string;
      readonly channel?: string;
      readonly successUrl?: string | null;
      readonly failUrl?: string | null;
      readonly durations?: ReadonlyArray<{ readonly subscriptionId: string; readonly days: number }>;
      readonly plans?: ReadonlyArray<{ readonly subscriptionId: string; readonly planId: string }>;
      readonly addOns?: ReadonlyArray<{ readonly subscriptionId: string; readonly addOnIds: readonly string[] }>;
      readonly expectedAmount?: string;
      readonly expectedCurrency?: string;
      readonly idempotencyKey?: string;
      readonly savedPaymentMethodId?: string;
      readonly savePaymentMethod?: boolean;
      readonly savePaymentMethodConsent?: boolean;
    },
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      subscriptionIds: input.subscriptionIds,
      gatewayType: input.gatewayType,
    };
    if (typeof input.expectedAmount === 'string') payload['expectedAmount'] = input.expectedAmount;
    if (typeof input.expectedCurrency === 'string') payload['expectedCurrency'] = input.expectedCurrency;
    if (typeof identity.userId === 'string' && identity.userId.length > 0) {
      payload['userId'] = identity.userId;
    }
    if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
      payload['telegramId'] = identity.telegramId;
    }
    if (typeof input.channel === 'string' && input.channel.length > 0) {
      payload['channel'] = input.channel;
    }
    if (input.successUrl) payload['successUrl'] = input.successUrl;
    if (input.failUrl) payload['failUrl'] = input.failUrl;
    if (input.durations && input.durations.length > 0) {
      payload['durations'] = input.durations;
    }
    if (input.plans && input.plans.length > 0) {
      payload['plans'] = input.plans;
    }
    if (input.addOns && input.addOns.length > 0) {
      payload['addOns'] = input.addOns;
    }
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      payload['idempotencyKey'] = input.idempotencyKey;
    }
    if (typeof input.savedPaymentMethodId === 'string' && input.savedPaymentMethodId.length > 0) {
      payload['savedPaymentMethodId'] = input.savedPaymentMethodId;
    }
    if (typeof input.savePaymentMethod === 'boolean') {
      payload['savePaymentMethod'] = input.savePaymentMethod;
    }
    if (typeof input.savePaymentMethodConsent === 'boolean') {
      payload['savePaymentMethodConsent'] = input.savePaymentMethodConsent;
    }
    return this.transport.request('POST', '/api/internal/payments/renewal-checkout', payload);
  }
}
