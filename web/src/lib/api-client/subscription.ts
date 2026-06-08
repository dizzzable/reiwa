/**
 * Subscription namespace — single active sub, all subs, action policy,
 * quote, upgrade options, trial.
 */
import { apiClient } from "./transport.js";
import type {
  ActionPolicy,
  AllSubscriptionsResponse,
  RenewalOptions,
  Subscription,
  SubscriptionQuote,
} from "@/types/api";

export const getSubscription = () =>
  apiClient.get<Subscription | null>("/subscription").then((r) => r.data);

export const getActionPolicy = (planId?: string | number) =>
  apiClient
    .post<ActionPolicy>("/subscription/action-policy", { planId })
    .then((r) => r.data);

export const getQuote = (
  planId: string | number,
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

/**
 * Self-service deletion of one of the user's own subscriptions. Final and
 * non-refundable: the server revokes the Remnawave profile and soft-deletes
 * the row. The SPA should refresh subscription/device queries on success.
 */
export const deleteSubscription = (subscriptionId: string) =>
  apiClient
    .delete<{ deleted: true }>(`/subscription/${subscriptionId}`)
    .then((r) => r.data);

/**
 * Lists the user's renewable subscriptions with per-item renewal pricing.
 * Pass the selected `gatewayType` for an accurate combined total; omit it
 * for an indicative price using the default-resolved gateway. `subscriptionIds`
 * narrows pricing to a chosen subset (used on the review step).
 */
export const getRenewalOptions = (input?: {
  subscriptionIds?: (string | number)[];
  gatewayType?: string;
}) =>
  apiClient
    .post<RenewalOptions>("/subscription/renewal-options", {
      ...(input?.subscriptionIds ? { subscriptionIds: input.subscriptionIds } : {}),
      ...(input?.gatewayType ? { gatewayType: input.gatewayType } : {}),
    })
    .then((r) => r.data);

export interface UpgradePlanOption {
  id: string;
  name: string;
  tag: string | null;
  type: string;
  trafficLimit: number | null;
  deviceLimit: number;
  durations: { id: string; days: number }[];
}

export interface UpgradeOptions {
  subscriptionId: string;
  plans: UpgradePlanOption[];
  warnings: { code: string; message: string }[];
}

/** Upgrade target plans (+ durations) for a subscription. */
export const getUpgradeOptions = (subscriptionId: string, gatewayType?: string) =>
  apiClient
    .post<UpgradeOptions>("/subscription/upgrade-options", {
      subscriptionId,
      ...(gatewayType ? { gatewayType } : {}),
    })
    .then((r) => r.data);

// ── Trial sub-flow ───────────────────────────────────────────────────────────
export const getTrialEligibility = () =>
  apiClient.get("/subscription/trial/eligibility").then((r) => r.data);

export const activateTrial = () =>
  apiClient.post("/subscription/trial").then((r) => r.data);
