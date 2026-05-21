import { create } from "zustand";
import type { Plan, PlanDuration, SubscriptionQuote } from "@/types/api";

type PurchaseStep =
  | "plans"
  | "duration"
  | "gateway"
  | "quote"
  | "checkout"
  | "polling";

export type GatewayOption = {
  id: string;
  label: string;
  icon: string;
  currency: string;
};

// Gateways are now fetched dynamically via GET /api/v1/gateways
export const GATEWAY_OPTIONS: GatewayOption[] = [];

interface PurchaseState {
  step: PurchaseStep;
  selectedPlan: Plan | null;
  selectedDuration: PlanDuration | null;
  selectedGateway: GatewayOption | null;
  quote: SubscriptionQuote | null;
  paymentId: string | null;
  paymentUrl: string | null;

  // Actions
  selectPlan: (plan: Plan) => void;
  selectDuration: (duration: PlanDuration) => void;
  selectGateway: (gateway: GatewayOption) => void;
  setQuote: (quote: SubscriptionQuote) => void;
  setCheckoutResult: (paymentId: string, paymentUrl: string) => void;
  goBack: () => void;
  reset: () => void;
}

const STEP_BACK: Record<PurchaseStep, PurchaseStep | null> = {
  plans: null,
  duration: "plans",
  gateway: "duration",
  quote: "gateway",
  checkout: "quote",
  polling: null,
};

export const usePurchaseStore = create<PurchaseState>((set) => ({
  step: "plans",
  selectedPlan: null,
  selectedDuration: null,
  selectedGateway: null,
  quote: null,
  paymentId: null,
  paymentUrl: null,

  selectPlan: (plan) => set({ selectedPlan: plan, step: "duration" }),
  selectDuration: (duration) =>
    set({ selectedDuration: duration, step: "gateway" }),
  selectGateway: (gateway) => set({ selectedGateway: gateway, step: "quote" }),
  setQuote: (quote) => set({ quote, step: "checkout" }),
  setCheckoutResult: (paymentId, paymentUrl) =>
    set({ paymentId, paymentUrl, step: "polling" }),

  goBack: () =>
    set((state) => {
      const prev = STEP_BACK[state.step];
      if (!prev) return state;
      const reset: Partial<PurchaseState> = { step: prev };
      if (prev === "plans") reset.selectedDuration = null;
      if (prev === "duration") reset.selectedGateway = null;
      if (prev === "gateway") reset.quote = null;
      return { ...state, ...reset };
    }),

  reset: () =>
    set({
      step: "plans",
      selectedPlan: null,
      selectedDuration: null,
      selectedGateway: null,
      quote: null,
      paymentId: null,
      paymentUrl: null,
    }),
}));
