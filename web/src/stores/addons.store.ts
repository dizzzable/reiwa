import { create } from "zustand";

import type { GatewayOption } from "./purchase.store";
import type { EligibleAddOn } from "@/lib/api-client";

export type AddOnStep = "subscriptions" | "addon" | "gateway" | "review" | "checkout";

interface AddOnState {
  step: AddOnStep;
  selectedSubscriptionId: string | null;
  selectedAddOn: EligibleAddOn | null;
  selectedGateway: GatewayOption | null;

  setStep: (step: AddOnStep) => void;
  selectSubscription: (id: string) => void;
  selectAddOn: (addOn: EligibleAddOn) => void;
  selectGateway: (gateway: GatewayOption) => void;
  confirm: () => void;
  reset: () => void;
}

const INITIAL: Pick<
  AddOnState,
  "step" | "selectedSubscriptionId" | "selectedAddOn" | "selectedGateway"
> = {
  step: "subscriptions",
  selectedSubscriptionId: null,
  selectedAddOn: null,
  selectedGateway: null,
};

export const useAddOnStore = create<AddOnState>((set) => ({
  ...INITIAL,

  setStep: (step) => set({ step }),
  // Choosing a subscription resets the downstream add-on/gateway selection and
  // advances to the add-on list.
  selectSubscription: (id) =>
    set({ selectedSubscriptionId: id, selectedAddOn: null, selectedGateway: null, step: "addon" }),
  // Re-picking an add-on clears any previously chosen gateway so a stale
  // gateway can never carry into a new selection.
  selectAddOn: (addOn) => set({ selectedAddOn: addOn, selectedGateway: null, step: "gateway" }),
  // Gateway choice advances to an explicit review/confirmation step rather than
  // auto-starting the payment, so the user confirms subscription + add-on +
  // gateway + exact price before any charge.
  selectGateway: (gateway) => set({ selectedGateway: gateway, step: "review" }),
  confirm: () => set({ step: "checkout" }),
  reset: () => set({ ...INITIAL }),
}));
