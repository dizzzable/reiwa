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
  /** Composition key whose defaults were already applied. Prevents a remount
   *  from re-selecting add-ons the user explicitly unchecked. */
  reofferInitializedKey: string | null;
  /** Add-ons explicitly removed by the user, retained across A→B→A. */
  explicitlyDeselectedAddOns: Record<string, true>;
  selectedGateway: GatewayOption | null;
  /** Saved card/SBP method for off-session YooKassa charge; null = hosted page. */
  selectedSavedPaymentMethodId: string | null;
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
  toggleAddOn: (subscriptionId: string, addOnId: string) => void;
  /** Replace the whole add-on selection for a subscription (deterministic
   *  pre-select for the renewal re-offer). Empty array clears it. */
  setSelectedAddOns: (subscriptionId: string, addOnIds: string[]) => void;
  initializeReoffer: (key: string, selectedAddOns: Record<string, string[]>) => void;
  /** New composition gets defaults. A settled refetch for the same composition
   * only removes selections that are no longer allowed; it never restores an
   * add-on the user explicitly deselected. */
  reconcileReoffer: (key: string, allowedAddOns: Record<string, string[]>) => void;
  selectGateway: (gateway: GatewayOption) => void;
  selectSavedPaymentMethod: (methodId: string | null) => void;
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
  | "selectedAddOns"
  | "reofferInitializedKey"
  | "explicitlyDeselectedAddOns"
  | "selectedGateway"
  | "selectedSavedPaymentMethodId"
  | "reviewQuote"
  | "paymentId"
  | "paymentUrl"
  | "navDirection"
> = {
  step: "subscriptions",
  selectedSubscriptionIds: [],
  selectedDurations: {},
  selectedPlans: {},
  selectedAddOns: {},
  reofferInitializedKey: null,
  explicitlyDeselectedAddOns: {},
  selectedGateway: null,
  selectedSavedPaymentMethodId: null,
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
      const explicitKey = `${subscriptionId}:${addOnId}`;
      const explicitlyDeselectedAddOns = { ...state.explicitlyDeselectedAddOns };
      if (next.length > 0) selectedAddOns[subscriptionId] = next;
      else delete selectedAddOns[subscriptionId];
      if (current.includes(addOnId)) explicitlyDeselectedAddOns[explicitKey] = true;
      else delete explicitlyDeselectedAddOns[explicitKey];
      return { selectedAddOns, explicitlyDeselectedAddOns };
    }),
  setSelectedAddOns: (subscriptionId, addOnIds) =>
    set((state) => {
      const selectedAddOns = { ...state.selectedAddOns };
      if (addOnIds.length > 0) selectedAddOns[subscriptionId] = [...addOnIds];
      else delete selectedAddOns[subscriptionId];
      return { selectedAddOns };
    }),
  initializeReoffer: (key, selectedAddOns) =>
    set((state) =>
      state.reofferInitializedKey === key
        ? state
        : {
            selectedAddOns: Object.fromEntries(
              Object.entries(selectedAddOns)
                .map(([subscriptionId, ids]) => [
                  subscriptionId,
                  ids.filter((id) => !state.explicitlyDeselectedAddOns[`${subscriptionId}:${id}`]),
                ])
                .filter(([, ids]) => ids.length > 0)
                .map(([subscriptionId, ids]) => [subscriptionId, [...ids]]),
            ),
            reofferInitializedKey: key,
          },
    ),
  reconcileReoffer: (key, allowedAddOns) =>
    set((state) => {
      const normalizedAllowed = Object.fromEntries(
        Object.entries(allowedAddOns)
          .map(([subscriptionId, ids]) => [
            subscriptionId,
            [...new Set(ids)].filter((id) => !state.explicitlyDeselectedAddOns[`${subscriptionId}:${id}`]),
          ])
          .filter(([, ids]) => ids.length > 0),
      );
      if (state.reofferInitializedKey !== key) {
        return {
          selectedAddOns: normalizedAllowed,
          reofferInitializedKey: key,
        };
      }

      const selectedAddOns: Record<string, string[]> = {};
      for (const [subscriptionId, selectedIds] of Object.entries(state.selectedAddOns)) {
        const allowed = new Set(normalizedAllowed[subscriptionId] ?? []);
        const retained = selectedIds.filter((id) => allowed.has(id));
        if (retained.length > 0) selectedAddOns[subscriptionId] = retained;
      }
      return { selectedAddOns };
    }),
  selectGateway: (gateway) =>
    set({ selectedGateway: gateway, selectedSavedPaymentMethodId: null, navDirection: "forward", reviewQuote: null }),
  selectSavedPaymentMethod: (methodId) => set({ selectedSavedPaymentMethodId: methodId }),
  setReviewQuote: (quote) => set({ reviewQuote: { ...quote } }),
  setCheckoutResult: (paymentId, paymentUrl) =>
    set({ paymentId, paymentUrl, step: "polling" }),
  reset: () => set({ ...INITIAL }),
}));
