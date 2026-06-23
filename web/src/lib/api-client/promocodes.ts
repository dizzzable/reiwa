/**
 * Promocodes namespace — activation, history, eligibility check.
 */
import { apiClient } from "./transport.js";
import type {
  PromoActivationsResponse,
  Subscription,
} from "@/types/api";

/** Multi-step activation result returned by the rezeis promo pipeline. */
export type PromoActivationStep =
  | "ACTIVATED"
  | "SELECT_SUBSCRIPTION"
  | "CREATE_NEW"
  | "REJECTED";

export interface PromoActivationResult {
  readonly step: PromoActivationStep;
  /** Stable i18n key from the backend (e.g. `ntf-promocode-activated-duration`). */
  readonly messageKey: string;
  readonly errorCode: string | null;
  /** Subscription ids to choose from when `step === "SELECT_SUBSCRIPTION"`. */
  readonly availableSubscriptionIds: readonly string[];
  readonly reward: { readonly type: string; readonly value: number } | null;
}

export const activatePromocode = (
  code: string,
  opts?: { subscriptionId?: string; confirmCreateNew?: boolean },
) =>
  apiClient
    .post<PromoActivationResult>("/promocode/activate", {
      code,
      subscriptionId: opts?.subscriptionId,
      confirmCreateNew: opts?.confirmCreateNew,
    })
    .then((r) => r.data);

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
