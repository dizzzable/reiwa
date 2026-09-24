import { create } from "zustand";

import type { GatewayOption } from "./purchase.store";

export type RenewalStep = "subscriptions" | "plan" | "gateway" | "review" | "checkout" | "polling";

interface RenewalState {
  step: RenewalStep;
  /** Subscriptions the user chose to renew (≥1 once past the selection step). */
  selectedSubscriptionIds: string[];
  /** Per-subscription chosen renewal duration (days). Absent → original. */
  selectedDurations: Record<string, number>;
  /** Per-subscription chosen plan id (for plan-less, panel-imported subs). */
  selectedPlans: Record<string, string>;
  selectedGateway: GatewayOption | null;
  /** Saved card/SBP method for off-session YooKassa charge; null = hosted page. */
  selectedSavedPaymentMethodId: string | null;
  /**
   * Consent to bind a new YooKassa method for future autopay (interactive
   * YOOKASSA only — not used when a saved method is selected).
   */
  savePaymentMethodConsent: boolean;
  /** Exact all-in quote confirmed on the review step. */
  reviewQuote: { amount: string; currency: string } | null;
  paymentId: string | null;
  paymentUrl: string | null;
  /** Direction of the last step change — guards auto-advance effects so
   *  pressing "back" doesn't immediately re-advance (single-gateway trap). */
  navDirection: "forward" | "back";

  setStep: (step: RenewalStep) => void;
  goBack: (step: RenewalStep) => void;
  toggleSubscription: (id: string) => void;
  setSelectedSubscriptions: (ids: string[]) => void;
  setSelectedDuration: (subscriptionId: string, days: number) => void;
  setSelectedPlan: (subscriptionId: string, planId: string) => void;
  selectGateway: (gateway: GatewayOption) => void;
  selectSavedPaymentMethod: (methodId: string | null) => void;
  setSavePaymentMethodConsent: (consent: boolean) => void;
  setReviewQuote: (quote: { amount: string; currency: string }) => void;
  setCheckoutResult: (paymentId: string, paymentUrl: string | null) => void;
  reset: () => void;
}

const INITIAL: Pick<
  RenewalState,
  | "step"
  | "selectedSubscriptionIds"
  | "selectedDurations"
  | "selectedPlans"
  | "selectedGateway"
  | "selectedSavedPaymentMethodId"
  | "savePaymentMethodConsent"
  | "reviewQuote"
  | "paymentId"
  | "paymentUrl"
  | "navDirection"
> = {
  step: "subscriptions",
  selectedSubscriptionIds: [],
  selectedDurations: {},
  selectedPlans: {},
  selectedGateway: null,
  selectedSavedPaymentMethodId: null,
  savePaymentMethodConsent: false,
  reviewQuote: null,
  paymentId: null,
  paymentUrl: null,
  navDirection: "forward",
};

export const useRenewalStore = create<RenewalState>((set) => ({
  ...INITIAL,

  setStep: (step) => set({ step, navDirection: "forward" }),
  goBack: (step) => set({ step, navDirection: "back" }),
  toggleSubscription: (id) =>
    set((state) => ({
      selectedSubscriptionIds: state.selectedSubscriptionIds.includes(id)
        ? state.selectedSubscriptionIds.filter((x) => x !== id)
        : [...state.selectedSubscriptionIds, id],
    })),
  setSelectedSubscriptions: (ids) => set({ selectedSubscriptionIds: ids }),
  setSelectedDuration: (subscriptionId, days) =>
    set((state) => ({
      selectedDurations: { ...state.selectedDurations, [subscriptionId]: days },
    })),
  setSelectedPlan: (subscriptionId, planId) =>
    set((state) => ({
      selectedPlans: { ...state.selectedPlans, [subscriptionId]: planId },
    })),
  selectGateway: (gateway) =>
    set({
      selectedGateway: gateway,
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: gateway.autopay === true,
      navDirection: "forward",
      reviewQuote: null,
    }),
  selectSavedPaymentMethod: (methodId) => set({ selectedSavedPaymentMethodId: methodId }),
  setSavePaymentMethodConsent: (consent) => set({ savePaymentMethodConsent: consent }),
  setReviewQuote: (quote) => set({ reviewQuote: { ...quote } }),
  setCheckoutResult: (paymentId, paymentUrl) =>
    set({ paymentId, paymentUrl, step: "polling" }),
  reset: () => set({ ...INITIAL }),
}));
