import { create } from "zustand";

import type { GatewayOption } from "./purchase.store";

export type RenewalStep = "subscriptions" | "plan" | "addons" | "gateway" | "review" | "checkout" | "polling";

interface RenewalState {
  step: RenewalStep;
  /** Subscriptions the user chose to renew (≥1 once past the selection step). */
  selectedSubscriptionIds: string[];
  /** Per-subscription chosen renewal duration (days). Absent → original. */
  selectedDurations: Record<string, number>;
  /** Per-subscription chosen plan id (for plan-less, panel-imported subs). */
  selectedPlans: Record<string, string>;
  /** Per-subscription selected renewal add-on ids (T-015). Empty/absent →
   *  no add-ons. Only forwarded when the backend `renewalAddOns` flag is on. */
  selectedAddOns: Record<string, string[]>;
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
  toggleAddOn: (subscriptionId: string, addOnId: string) => void;
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
  | "selectedAddOns"
  | "selectedGateway"
  | "paymentId"
  | "paymentUrl"
  | "navDirection"
> = {
  step: "subscriptions",
  selectedSubscriptionIds: [],
  selectedDurations: {},
  selectedPlans: {},
  selectedAddOns: {},
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
    set((state) => {
      const nowSelected = state.selectedSubscriptionIds.includes(id);
      // Deselecting a subscription drops any add-ons picked for it so a stale
      // selection can never be priced/forwarded for a subscription the user
      // is no longer renewing.
      const nextAddOns = { ...state.selectedAddOns };
      if (nowSelected) delete nextAddOns[id];
      return {
        selectedSubscriptionIds: nowSelected
          ? state.selectedSubscriptionIds.filter((x) => x !== id)
          : [...state.selectedSubscriptionIds, id],
        selectedAddOns: nextAddOns,
      };
    }),
  setSelectedSubscriptions: (ids) => set({ selectedSubscriptionIds: ids }),
  setSelectedDuration: (subscriptionId, days) =>
    set((state) => ({
      selectedDurations: { ...state.selectedDurations, [subscriptionId]: days },
    })),
  setSelectedPlan: (subscriptionId, planId) =>
    set((state) => ({
      selectedPlans: { ...state.selectedPlans, [subscriptionId]: planId },
    })),
  toggleAddOn: (subscriptionId, addOnId) =>
    set((state) => {
      const current = state.selectedAddOns[subscriptionId] ?? [];
      const next = current.includes(addOnId)
        ? current.filter((x) => x !== addOnId)
        : [...current, addOnId];
      const selectedAddOns = { ...state.selectedAddOns };
      if (next.length > 0) selectedAddOns[subscriptionId] = next;
      else delete selectedAddOns[subscriptionId];
      return { selectedAddOns };
    }),
  selectGateway: (gateway) => set({ selectedGateway: gateway, navDirection: "forward" }),
  setCheckoutResult: (paymentId, paymentUrl) =>
    set({ paymentId, paymentUrl, step: "polling" }),
  reset: () => set({ ...INITIAL }),
}));
