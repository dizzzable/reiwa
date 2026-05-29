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
  planId: number,
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
  planId: number,
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
  planId: number,
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
