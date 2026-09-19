/**
 * Saved payment methods — SPA API client.
 *
 * List methods saved after successful YooKassa payments (save_payment_method).
 * Unbind is local soft-deactivate so the cabinet can stop charging the method
 * without a provider-side "delete card" API.
 * Autopay can be disabled per method without unbinding.
 */
import { apiClient } from './transport.js';

export interface SavedPaymentMethod {
  id: string;
  gatewayType: string;
  methodType: string;
  title: string;
  cardLast4: string | null;
  cardFirst6: string | null;
  cardExpiryMonth: string | null;
  cardExpiryYear: string | null;
  cardIssuerCountry: string | null;
  cardProduct: string | null;
  /** When false, off-session charge is blocked; method stays bound. */
  autopayEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Automatic charging the PROVIDER runs (Platega): a fixed sum every period,
 * confirmed once in the bank. Nothing is saved on our side, so it has no card
 * row; «Способы оплаты» lists it to let the customer switch it off.
 */
export interface ProviderSubscription {
  id: string;
  gatewayType: string;
  /** PAST_DUE: the last charge failed, and the provider does not retry it. */
  status: "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" | "FAILED";
  amount: string;
  currency: string;
  intervalUnit: "day" | "week" | "month" | "year" | string;
  intervalCount: number;
  durationDays: number;
  planName: string | null;
  subscriptionId: string | null;
  nextChargeAt: string | null;
  lastChargeAt: string | null;
}

export interface SavedPaymentMethodsResponse {
  methods: SavedPaymentMethod[];
  total: number;
  capabilities?: {
    yookassaStandaloneSetup: boolean;
  };
  /** Absent from a panel older than this cabinet. */
  providerSubscriptions?: ProviderSubscription[];
}

/** Whether «Способы оплаты» has anything for this customer to manage. */
export function hasManageablePaymentMethods(data: SavedPaymentMethodsResponse | undefined): boolean {
  return (data?.methods ?? []).length > 0 || (data?.providerSubscriptions ?? []).length > 0;
}

export interface PaymentMethodSetup {
  setupId: string;
  checkoutUrl: string;
  expiresAt: string;
}

export interface PaymentMethodSetupStatus {
  status: 'PENDING' | 'ACTIVE' | 'INACTIVE' | 'FAILED' | 'EXPIRED';
  expiresAt: string;
}

export const getPaymentMethods = () =>
  apiClient
    .get('/payment-methods')
    .then((r) => r.data as SavedPaymentMethodsResponse);

export const unbindPaymentMethod = (methodId: string) =>
  apiClient
    .delete(`/payment-methods/${encodeURIComponent(methodId)}`)
    .then((r) => r.data as { unbound: true; id: string });

export const setPaymentMethodAutopay = (methodId: string, autopayEnabled: boolean) =>
  apiClient
    .patch(`/payment-methods/${encodeURIComponent(methodId)}`, { autopayEnabled })
    .then((r) => r.data as { id: string; autopayEnabled: boolean });

export const cancelProviderSubscription = (subscriptionId: string) =>
  apiClient
    .post(`/payment-methods/provider-subscriptions/${encodeURIComponent(subscriptionId)}/cancel`)
    .then((r) => r.data as { cancelled: true });

export const startPaymentMethodSetup = () =>
  apiClient
    .post('/payment-methods/setup', { consent: true })
    .then((r) => r.data as PaymentMethodSetup);

export const getPaymentMethodSetupStatus = (setupId: string) =>
  apiClient
    .get(`/payment-methods/setup/${encodeURIComponent(setupId)}`)
    .then((r) => r.data as PaymentMethodSetupStatus);
