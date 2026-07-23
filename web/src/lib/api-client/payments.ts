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
import type { CheckoutResult, PaymentPurchaseType, PaymentStatus } from "@/types/api";

export type CreationPurchaseType = Extract<PaymentPurchaseType, "NEW" | "ADDITIONAL">;

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
  savedPaymentMethodId?: string | null,
  savePaymentMethod?: boolean,
  savePaymentMethodConsent?: boolean,
  purchaseType: CreationPurchaseType = "NEW",
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType,
      deviceType,
      source: getClientSource(),
      ...(typeof savedPaymentMethodId === "string" && savedPaymentMethodId.length > 0
        ? { savedPaymentMethodId }
        : {}),
      ...(typeof savePaymentMethod === "boolean" ? { savePaymentMethod } : {}),
      ...(typeof savePaymentMethodConsent === "boolean"
        ? { savePaymentMethodConsent }
        : {}),
    })
    .then((r) => r.data);

export const createRenewCheckout = (
  planId: string | number,
  durationDays: number,
  gatewayType: string,
  subscriptionId: number | string,
  savedPaymentMethodId?: string | null,
  savePaymentMethod?: boolean,
  savePaymentMethodConsent?: boolean,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType: "RENEW",
      subscriptionId,
      source: getClientSource(),
      ...(typeof savedPaymentMethodId === "string" && savedPaymentMethodId.length > 0
        ? { savedPaymentMethodId }
        : {}),
      ...(typeof savePaymentMethod === "boolean" ? { savePaymentMethod } : {}),
      ...(typeof savePaymentMethodConsent === "boolean"
        ? { savePaymentMethodConsent }
        : {}),
    })
    .then((r) => r.data);

export const createUpgradeCheckout = (
  planId: string | number,
  durationDays: number,
  gatewayType: string,
  subscriptionId: number | string,
  savedPaymentMethodId?: string | null,
  savePaymentMethod?: boolean,
  savePaymentMethodConsent?: boolean,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType: "UPGRADE",
      subscriptionId,
      source: getClientSource(),
      ...(typeof savedPaymentMethodId === "string" && savedPaymentMethodId.length > 0
        ? { savedPaymentMethodId }
        : {}),
      ...(typeof savePaymentMethod === "boolean" ? { savePaymentMethod } : {}),
      ...(typeof savePaymentMethodConsent === "boolean"
        ? { savePaymentMethodConsent }
        : {}),
    })
    .then((r) => r.data);

export const getPaymentStatus = (paymentId: string) =>
  apiClient
    .get<PaymentStatus>(`/payments/${encodeURIComponent(paymentId)}`)
    .then((r) => r.data);

/**
 * Combined multi-subscription renewal: one provider checkout for the summed
 * total. Each id renews on its original plan and duration server-side. The
 * `source` hint preserves the post-payment redirect surface (Mini App vs web).
 */
export const createRenewalCheckout = (
  subscriptionIds: (string | number)[],
  gatewayType: string,
  expectedQuote: { amount: string; currency: string },
  durations?: { subscriptionId: string; days: number }[],
  plans?: { subscriptionId: string; planId: string }[],
  addOns?: { subscriptionId: string; addOnIds: string[] }[],
  idempotencyKey?: string,
  savedPaymentMethodId?: string | null,
  savePaymentMethod?: boolean,
  savePaymentMethodConsent?: boolean,
) =>
  apiClient
    .post<CheckoutResult>("/payments/renewal-checkout", {
      subscriptionIds,
      gatewayType,
      expectedAmount: expectedQuote.amount,
      expectedCurrency: expectedQuote.currency,
      source: getClientSource(),
      ...(durations && durations.length > 0 ? { durations } : {}),
      ...(plans && plans.length > 0 ? { plans } : {}),
      ...(addOns && addOns.some((a) => a.addOnIds.length > 0)
        ? { addOns: addOns.filter((a) => a.addOnIds.length > 0) }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(typeof savedPaymentMethodId === "string" && savedPaymentMethodId.length > 0
        ? { savedPaymentMethodId }
        : {}),
      ...(typeof savePaymentMethod === "boolean" ? { savePaymentMethod } : {}),
      ...(typeof savePaymentMethodConsent === "boolean"
        ? { savePaymentMethodConsent }
        : {}),
    })
    .then((r) => r.data);
