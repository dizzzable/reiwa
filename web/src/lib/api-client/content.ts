/**
 * Content namespace — operator-managed FAQ and plan add-ons.
 */
import { apiClient } from "./transport.js";

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  mediaUrls?: string[];
  orderIndex?: number;
  locale?: string | null;
}

export interface AddOnPrice {
  id: string;
  currency: string;
  price: string;
}

export interface AddOn {
  id: string;
  name: string;
  description: string | null;
  type: "EXTRA_TRAFFIC" | "EXTRA_DEVICES";
  value: number;
  isActive: boolean;
  orderIndex: number;
  applicablePlanIds: string[];
  prices: AddOnPrice[];
}

export const getFaq = (locale?: string) =>
  apiClient
    .get<{ items: FaqItem[] }>("/faq", {
      params: locale ? { locale } : undefined,
    })
    .then((r) => r.data.items ?? []);

export const getPlanAddOns = (planId: number | string) =>
  apiClient
    .get<{ addOns: AddOn[] }>(`/add-ons/plan/${planId}`)
    .then((r) => r.data.addOns ?? []);

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
}) =>
  apiClient
    .post<AddOnCheckoutResult>("/add-ons/purchase", input)
    .then((r) => r.data);
