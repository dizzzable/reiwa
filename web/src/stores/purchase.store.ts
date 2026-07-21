import { create } from "zustand";
import type { Plan, PlanDuration, SubscriptionQuote } from "@/types/api";

type PurchaseStep =
  | "plans"
  | "duration"
  | "device"
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

/** Device the user intends to use the subscription on. */
export type DeviceTypeOption = "ANDROID" | "IPHONE" | "WINDOWS" | "MAC";

// Gateways are now fetched dynamically via GET /api/v1/gateways
export const GATEWAY_OPTIONS: GatewayOption[] = [];

interface PurchaseState {
  step: PurchaseStep;
  /** Direction of the last navigation — lets steps avoid auto-advancing
   *  when the user navigated BACK into them (fixes the single-gateway loop). */
  lastNav: "forward" | "back";
  selectedPlan: Plan | null;
  selectedDuration: PlanDuration | null;
  selectedDevice: DeviceTypeOption | null;
  selectedGateway: GatewayOption | null;
  /** Saved card/SBP method for off-session YooKassa charge; null = hosted page. */
  selectedSavedPaymentMethodId: string | null;
  /**
   * Consent to bind a new YooKassa payment method for future autopay.
   * Only relevant for interactive YOOKASSA checkout (no saved method selected).
   */
  savePaymentMethodConsent: boolean;
  quote: SubscriptionQuote | null;
  paymentId: string | null;
  paymentUrl: string | null;

  // Actions
  selectPlan: (plan: Plan) => void;
  selectDuration: (duration: PlanDuration) => void;
  selectDevice: (device: DeviceTypeOption) => void;
  selectGateway: (gateway: GatewayOption) => void;
  selectSavedPaymentMethod: (methodId: string | null) => void;
  setSavePaymentMethodConsent: (consent: boolean) => void;
  setQuote: (quote: SubscriptionQuote) => void;
  setCheckoutResult: (paymentId: string, paymentUrl: string | null) => void;
  goBack: () => void;
  reset: () => void;
}

const STEP_BACK: Record<PurchaseStep, PurchaseStep | null> = {
  plans: null,
  duration: "plans",
  device: "duration",
  gateway: "device",
  quote: "gateway",
  checkout: "quote",
  polling: null,
};

export const usePurchaseStore = create<PurchaseState>((set) => ({
  step: "plans",
  lastNav: "forward",
  selectedPlan: null,
  selectedDuration: null,
  selectedDevice: null,
  selectedGateway: null,
  selectedSavedPaymentMethodId: null,
  savePaymentMethodConsent: false,
  quote: null,
  paymentId: null,
  paymentUrl: null,

  selectPlan: (plan) => set({ selectedPlan: plan, step: "duration", lastNav: "forward" }),
  selectDuration: (duration) =>
    set({ selectedDuration: duration, step: "device", lastNav: "forward" }),
  selectDevice: (device) => set({ selectedDevice: device, step: "gateway", lastNav: "forward" }),
  selectGateway: (gateway) =>
    set({
      selectedGateway: gateway,
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: false,
      step: "quote",
      lastNav: "forward",
    }),
  selectSavedPaymentMethod: (methodId) => set({ selectedSavedPaymentMethodId: methodId }),
  setSavePaymentMethodConsent: (consent) => set({ savePaymentMethodConsent: consent }),
  setQuote: (quote) => set({ quote, step: "checkout", lastNav: "forward" }),
  setCheckoutResult: (paymentId, paymentUrl) =>
    set({ paymentId, paymentUrl, step: "polling", lastNav: "forward" }),

  goBack: () =>
    set((state) => {
      const prev = STEP_BACK[state.step];
      if (!prev) return state;
      const reset: Partial<PurchaseState> = { step: prev, lastNav: "back" };
      // Clear the selection made AT the step we are leaving, so re-entering a
      // step (esp. an auto-selecting one) doesn't immediately bounce forward.
      if (state.step === "device") reset.selectedDevice = null;
      if (state.step === "gateway") {
        reset.selectedGateway = null;
        reset.selectedSavedPaymentMethodId = null;
      }
      if (state.step === "quote") reset.quote = null;
      return { ...state, ...reset };
    }),

  reset: () =>
    set({
      step: "plans",
      lastNav: "forward",
      selectedPlan: null,
      selectedDuration: null,
      selectedDevice: null,
      selectedGateway: null,
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: false,
      quote: null,
      paymentId: null,
      paymentUrl: null,
    }),
}));
