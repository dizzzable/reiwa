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

/**
 * A legal document the operator switched on — plain text, already resolved to
 * the requested locale upstream.
 *
 * `body` is NEVER markup. Render it with `white-space: pre-wrap` and nothing
 * else: this type is reachable from the pre-login registration bundle, which
 * deliberately ships without a sanitizer.
 */
/**
 * Mirrors `LEGAL_DOCUMENT_KEYS` in
 * `src/infrastructure/admin-client/namespaces/legal-documents.ts`, which the
 * edge validates the registration payload against.
 *
 * Restated rather than imported: this module is in the browser bundle and
 * that one is server code. `legal-document-keys-parity.test.ts` compares the
 * two files so the copy cannot drift silently — a cabinet that omits a key
 * the panel serves ticks a box the edge then rejects.
 */
export const LEGAL_DOCUMENT_KEYS = ["USER_AGREEMENT", "PRIVACY_POLICY", "OFFER"] as const;

export type LegalDocumentKey = (typeof LEGAL_DOCUMENT_KEYS)[number];

export interface LegalDocument {
  key: LegalDocumentKey;
  title: string;
  body: string;
}

export const getLegalDocuments = (locale?: string) =>
  apiClient
    .get<{ documents: LegalDocument[] }>("/legal-documents", {
      params: locale ? { locale } : undefined,
    })
    .then((r) => r.data.documents ?? []);

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
