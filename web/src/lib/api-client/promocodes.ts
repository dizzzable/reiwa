/**
 * Promocodes namespace — activation, history, eligibility check.
 */
import { apiClient } from "./transport.js";
import type {
  PromoActivationsResponse,
  Subscription,
} from "@/types/api";

export const activatePromocode = (
  code: string,
  subscriptionId?: number,
) =>
  apiClient.post("/promocode/activate", { code, subscriptionId }).then((r) => r.data);

export const getPromoActivations = (page = 1, limit = 20) =>
  apiClient
    .get<PromoActivationsResponse>("/promocode/activations", {
      params: { page, limit },
    })
    .then((r) => r.data);

export const getEligibleSubscriptions = () =>
  apiClient
    .get<Subscription[]>("/promocode/eligible-subscriptions")
    .then((r) => r.data);
