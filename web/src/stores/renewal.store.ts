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
  | "paymentId"
  | "paymentUrl"
  | "navDirection"
> = {
  step: "subscriptions",
  selectedSubscriptionIds: [],
  selectedDurations: {},
  selectedPlans: {},
  selectedGateway: null,
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
  selectGateway: (gateway) => set({ selectedGateway: gateway, step: "review", navDirection: "forward" }),
  setCheckoutResult: (paymentId, paymentUrl) =>
    set({ paymentId, paymentUrl, step: "polling" }),
  reset: () => set({ ...INITIAL }),
}));
