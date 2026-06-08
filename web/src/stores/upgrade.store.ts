import { create } from "zustand";

import type { GatewayOption } from "./purchase.store";
import type { UpgradePlanOption } from "@/lib/api-client/subscription";

export type UpgradeStep =
  | "subscriptions"
  | "plan"
  | "duration"
  | "gateway"
  | "review"
  | "checkout"
  | "polling";

interface UpgradeState {
  step: UpgradeStep;
  /** Single subscription being upgraded. */
  selectedSubscriptionId: string | null;
  selectedPlan: UpgradePlanOption | null;
  selectedDurationDays: number | null;
  selectedGateway: GatewayOption | null;
  paymentId: string | null;
  paymentUrl: string | null;

  setStep: (step: UpgradeStep) => void;
  selectSubscription: (id: string) => void;
  selectPlan: (plan: UpgradePlanOption) => void;
  selectDuration: (days: number) => void;
  selectGateway: (gateway: GatewayOption) => void;
  setCheckoutResult: (paymentId: string, paymentUrl: string | null) => void;
  reset: () => void;
}

const INITIAL = {
  step: "subscriptions" as UpgradeStep,
  selectedSubscriptionId: null,
  selectedPlan: null,
  selectedDurationDays: null,
  selectedGateway: null,
  paymentId: null,
  paymentUrl: null,
};

export const useUpgradeStore = create<UpgradeState>((set) => ({
  ...INITIAL,

  setStep: (step) => set({ step }),
  selectSubscription: (id) => set({ selectedSubscriptionId: id, step: "plan" }),
  selectPlan: (plan) => set({ selectedPlan: plan, selectedDurationDays: null, step: "duration" }),
  selectDuration: (days) => set({ selectedDurationDays: days, step: "gateway" }),
  selectGateway: (gateway) => set({ selectedGateway: gateway, step: "review" }),
  setCheckoutResult: (paymentId, paymentUrl) => set({ paymentId, paymentUrl, step: "polling" }),
  reset: () => set({ ...INITIAL }),
}));
