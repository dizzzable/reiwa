/**
 * Payments namespace — gateways, checkout (purchase / renew / upgrade),
 * status polling.
 *
 * `createCheckout` / `createRenewCheckout` / `createUpgradeCheckout`
 * all hit `/payments/checkout`; the differentiator is `purchaseType`
 * + `renewSubscriptionId`. Three exports keep the call sites readable
 * without a magic-string parameter.
 */
import { apiClient } from "./transport.js";
import { getClientSource } from "@/lib/client-source";
import type { CheckoutResult, PaymentStatus } from "@/types/api";

export interface GatewayOption {
  type: string;
  displayName: string;
  currency: string;
  isActive: boolean;
}

export const getEnabledGateways = () =>
  apiClient.get<GatewayOption[]>("/gateways").then((r) => r.data);

export const createCheckout = (
  planId: string | number,
  durationDays: number,
  gatewayType: string,
  deviceType?: string,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType: "NEW",
      deviceType,
    })
    .then((r) => r.data);

export const createRenewCheckout = (
  planId: string | number,
  durationDays: number,
  gatewayType: string,
  subscriptionId: number | string,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType: "RENEW",
      subscriptionId,
    })
    .then((r) => r.data);

export const createUpgradeCheckout = (
  planId: string | number,
  durationDays: number,
  gatewayType: string,
  subscriptionId: number | string,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType: "UPGRADE",
      subscriptionId,
    })
    .then((r) => r.data);

export const getPaymentStatus = (paymentId: string) =>
  apiClient.get<PaymentStatus>(`/payments/${paymentId}`).then((r) => r.data);

/**
 * Combined multi-subscription renewal: one provider checkout for the summed
 * total. Each id renews on its original plan and duration server-side. The
 * `source` hint preserves the post-payment redirect surface (Mini App vs web).
 */
export const createRenewalCheckout = (
  subscriptionIds: (string | number)[],
  gatewayType: string,
) =>
  apiClient
    .post<CheckoutResult>("/payments/renewal-checkout", {
      subscriptionIds,
      gatewayType,
      source: getClientSource(),
    })
    .then((r) => r.data);
