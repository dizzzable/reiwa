import { create } from "zustand";

import type { GatewayOption } from "./purchase.store";
import type { AddOn } from "@/lib/api-client";

export type AddOnStep = "subscriptions" | "addon" | "gateway" | "checkout";

interface AddOnState {
  step: AddOnStep;
  selectedSubscriptionId: string | null;
  selectedAddOn: AddOn | null;
  selectedGateway: GatewayOption | null;

  setStep: (step: AddOnStep) => void;
  selectSubscription: (id: string) => void;
  selectAddOn: (addOn: AddOn) => void;
  selectGateway: (gateway: GatewayOption) => void;
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
  selectAddOn: (addOn) => set({ selectedAddOn: addOn, step: "gateway" }),
  selectGateway: (gateway) => set({ selectedGateway: gateway, step: "checkout" }),
  reset: () => set({ ...INITIAL }),
}));
