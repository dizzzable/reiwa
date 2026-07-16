/**
 * Saved payment methods — SPA API client.
 *
 * List methods saved after successful YooKassa payments (save_payment_method).
 * Unbind is local soft-deactivate so the cabinet can stop charging the method
 * without a provider-side "delete card" API.
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
  createdAt: string;
  updatedAt: string;
}

export interface SavedPaymentMethodsResponse {
  methods: SavedPaymentMethod[];
  total: number;
}

export const getPaymentMethods = () =>
  apiClient
    .get('/payment-methods')
    .then((r) => r.data as SavedPaymentMethodsResponse);

export const unbindPaymentMethod = (methodId: string) =>
  apiClient
    .delete(`/payment-methods/${encodeURIComponent(methodId)}`)
    .then((r) => r.data as { unbound: true; id: string });
