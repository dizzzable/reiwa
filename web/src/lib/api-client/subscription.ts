/**
 * Subscription namespace — single active sub, all subs, action policy,
 * quote, upgrade options, trial.
 */
import { apiClient } from "./transport.js";
import type {
  ActionPolicy,
  AllSubscriptionsResponse,
  Subscription,
  SubscriptionQuote,
} from "@/types/api";

export const getSubscription = () =>
  apiClient.get<Subscription | null>("/subscription").then((r) => r.data);

export const getActionPolicy = (planId?: number) =>
  apiClient
    .post<ActionPolicy>("/subscription/action-policy", { planId })
    .then((r) => r.data);

export const getQuote = (
  planId: number,
  durationDays: number,
  gatewayType: string,
  purchaseType: "NEW" | "ADDITIONAL" | "RENEW" | "UPGRADE" | "TRIAL" = "NEW",
  subscriptionId?: number | string,
) =>
  apiClient
    .post<SubscriptionQuote>("/subscription/quote", {
      planId,
      durationDays,
      gatewayType,
      purchaseType,
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    })
    .then((r) => r.data);

export const getAllSubscriptions = () =>
  apiClient.get<AllSubscriptionsResponse>("/subscriptions/all").then((r) => r.data);

export const getUpgradeOptions = (subscriptionId: number) =>
  apiClient.get(`/subscription/${subscriptionId}/upgrade-options`).then((r) => r.data);

// ── Trial sub-flow ───────────────────────────────────────────────────────────
export const getTrialEligibility = () =>
  apiClient.get("/subscription/trial/eligibility").then((r) => r.data);

export const activateTrial = () =>
  apiClient.post("/subscription/trial").then((r) => r.data);
