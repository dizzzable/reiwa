import { create } from "zustand";

import type { GatewayOption } from "./purchase.store";

export type RenewalStep = "subscriptions" | "gateway" | "review" | "checkout" | "polling";

interface RenewalState {
  step: RenewalStep;
  /** Subscriptions the user chose to renew (≥1 once past the selection step). */
  selectedSubscriptionIds: string[];
  selectedGateway: GatewayOption | null;
  paymentId: string | null;
  paymentUrl: string | null;

  setStep: (step: RenewalStep) => void;
  toggleSubscription: (id: string) => void;
  setSelectedSubscriptions: (ids: string[]) => void;
  selectGateway: (gateway: GatewayOption) => void;
  setCheckoutResult: (paymentId: string, paymentUrl: string | null) => void;
  reset: () => void;
}

const INITIAL: Pick<
  RenewalState,
  "step" | "selectedSubscriptionIds" | "selectedGateway" | "paymentId" | "paymentUrl"
> = {
  step: "subscriptions",
  selectedSubscriptionIds: [],
  selectedGateway: null,
  paymentId: null,
  paymentUrl: null,
};

export const useRenewalStore = create<RenewalState>((set) => ({
  ...INITIAL,

  setStep: (step) => set({ step }),
  toggleSubscription: (id) =>
    set((state) => ({
      selectedSubscriptionIds: state.selectedSubscriptionIds.includes(id)
        ? state.selectedSubscriptionIds.filter((x) => x !== id)
        : [...state.selectedSubscriptionIds, id],
    })),
  setSelectedSubscriptions: (ids) => set({ selectedSubscriptionIds: ids }),
  selectGateway: (gateway) => set({ selectedGateway: gateway, step: "review" }),
  setCheckoutResult: (paymentId, paymentUrl) =>
    set({ paymentId, paymentUrl, step: "polling" }),
  reset: () => set({ ...INITIAL }),
}));
