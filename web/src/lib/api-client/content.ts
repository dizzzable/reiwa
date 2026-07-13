/**
 * Content namespace — operator-managed FAQ and plan add-ons.
 */
import { apiClient } from "./transport.js";
import { getClientSource } from "@/lib/client-source";

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  mediaUrls?: string[];
  orderIndex?: number;
  locale?: string | null;
}

export const getFaq = (locale?: string) =>
  apiClient
    .get<{ items: FaqItem[] }>("/faq", {
      params: locale ? { locale } : undefined,
    })
    .then((r) => r.data.items ?? []);

export interface AddOnCheckoutResult {
  paymentId: string;
  checkoutUrl: string | null;
  amount: string;
  currency: string;
  providerMode: string;
}

export const purchaseAddOn = (input: {
  addOnId: string;
  subscriptionId: string;
  gatewayType: string;
  /** v2 catalog revision the user saw — the backend rejects a stale
   *  composition (`ADDON_REVISION_CONFLICT`) rather than silently selling a
   *  repriced/changed add-on. */
  expectedAddOnRevision?: number;
  /** Client-generated request idempotency key — a re-POST (double mount /
   *  retry) with the same key replays the existing draft instead of minting a
   *  second PENDING transaction. */
  idempotencyKey?: string;
}) =>
  apiClient
    .post<AddOnCheckoutResult>("/add-ons/purchase", {
      ...input,
      source: getClientSource(),
    })
    .then((r) => r.data);

// ── Subscription-scoped add-on eligibility (contract v2, T-014) ──────────────
export interface EligibleAddOn {
  id: string;
  revision: number;
  name: string;
  description: string | null;
  type: "EXTRA_TRAFFIC" | "EXTRA_DEVICES";
  icon: string | null;
  value: number;
  lifetime: "UNTIL_NEXT_RESET" | "UNTIL_SUBSCRIPTION_END";
  eligibility: {
    eligible: true;
    activation: "NOW" | "TERM_START";
    expiresAt: string;
    explanationCode: string;
  };
  prices: { currency: string; price: string }[];
}

export interface AddOnEligibilityResult {
  contractVersion: 2;
  availability: "AVAILABLE" | "EMPTY";
  target: { subscriptionId: string; termId: string; planId: string } | null;
  addOns: EligibleAddOn[];
}

/**
 * Authoritative per-subscription add-on eligibility (finite-baseline gating +
 * server-resolved prices). Used by the renewal add-on selection step. An
 * upstream outage surfaces as an error (502) rather than a masked empty list.
 */
export const getSubscriptionAddOns = (subscriptionId: string) =>
  apiClient
    .get<AddOnEligibilityResult>(`/add-ons/subscriptions/${encodeURIComponent(subscriptionId)}`)
    .then((r) => r.data);
