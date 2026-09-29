// @vitest-environment jsdom

/**
 * Antilopay's «для автоматического списания»: two options, a card and SBP.
 *
 * Antilopay repeats a charge either on a card (the first payment on its form,
 * then it charges the card) or over SBP (the customer subscribes on the form),
 * and the two are different kinds of recurrent payment, chosen BEFORE the form
 * opens. So the gateway shows two «для автоматического списания» rows, each
 * with its own mark and caption, and the one picked travels with the checkout
 * as `autopayMethod` on a purchase and on a renewal alike.
 *
 * The real pages, the api mocked at the client module.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  createUpgradeCheckout: vi.fn(),
  createRenewalCheckout: vi.fn(),
  getActionPolicy: vi.fn(),
  getQuote: vi.fn(),
  getEnabledGateways: vi.fn(),
  getPaymentMethods: vi.fn(),
  activatePromocode: vi.fn(),
  getPartnerInfo: vi.fn(),
  payWithPartnerBalance: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getRenewalOptions: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
  getAddOnEntitlements: vi.fn(),
  getPlans: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
  useRenewalAddOnsEnabled: () => false,
}));

import PurchasePage from "../src/features/purchase/purchase-page";
import RenewalPage from "../src/features/renewal/renewal-page";
import { usePurchaseStore } from "../src/stores/purchase.store";
import { useRenewalStore } from "../src/stores/renewal.store";

const PAY = "purchase.quote.pay";
const CAPTION = "purchase.gateway.autopayCaption";
const CARD_CAPTION = "purchase.gateway.autopayCaptionCard";
const SBP_CAPTION = "purchase.gateway.autopayCaptionSbp";
const CARD_HINT = "purchase.quote.autopayProviderCardHint";
const SBP_HINT = "purchase.quote.autopayProviderHint";

const ANTILOPAY_WIRE = { type: "ANTILOPAY", displayName: "AntiloPay", currency: "RUB", isActive: true, autopay: true };
const PRICED = {
  planId: "plan-p",
  planName: "Plan P",
  durationDays: 30,
  currency: "RUB",
  basePrice: 299,
  finalPrice: 299,
  discountPercent: 0,
  gatewayType: "ANTILOPAY",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > until) throw new Error(`gave up waiting; the screen shows: ${text()}`);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

function buttons(): HTMLButtonElement[] {
  return [...(container?.querySelectorAll("button") ?? [])];
}

/** The AntiloPay row whose caption is exactly `caption`. */
function option(caption: string): HTMLButtonElement | undefined {
  return buttons().find(
    (candidate) =>
      candidate.textContent?.includes("AntiloPay") === true &&
      candidate.textContent.includes(caption) &&
      // «для автоматического списания» is inside the longer captions too.
      (caption !== CAPTION || (!candidate.textContent.includes(CARD_CAPTION) && !candidate.textContent.includes(SBP_CAPTION))),
  );
}

async function tap(target: HTMLButtonElement | undefined, what: string): Promise<void> {
  if (!target) throw new Error(`no ${what} on screen; it shows: ${text()}`);
  act(() => target.click());
  await settle();
}

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
}

async function mountPurchaseGateway(input: { days?: number; price?: Record<string, unknown> } = {}): Promise<void> {
  usePurchaseStore.setState({
    step: "gateway",
    lastNav: "forward",
    selectedPlan: { id: "plan-p", name: "Plan P", type: "BOTH", durations: [], isTrial: false } as never,
    selectedDuration: {
      id: "d-30",
      days: input.days ?? 30,
      prices: [{ currency: "RUB", price: "299", gatewayType: "ANTILOPAY", discountSource: "NONE", ...input.price }],
    } as never,
    selectedGateway: null,
    selectedSavedPaymentMethodId: null,
    savePaymentMethodConsent: false,
  });
  await mount(<PurchasePage />);
  await waitUntil(() => text().includes("AntiloPay"));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  api.getActionPolicy.mockResolvedValue({
    canBuy: true,
    canRenew: true,
    canUpgrade: true,
    canTrial: false,
    activeSubscriptionCount: 0,
    maxSubscriptions: 3,
    limitReached: false,
  });
  api.getQuote.mockResolvedValue(PRICED);
  api.getEnabledGateways.mockResolvedValue([ANTILOPAY_WIRE]);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getPartnerInfo.mockResolvedValue(null);
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
  api.createCheckout.mockResolvedValue({ paymentId: "pay-new", checkoutUrl: null });
  api.getPlans.mockResolvedValue([]);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  usePurchaseStore.getState().reset();
  useRenewalStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the purchase page offers Antilopay's automatic charging twice", () => {
  it("shows the ordinary payment, a card option and an SBP option, and nothing under the bare caption", async () => {
    await mountPurchaseGateway();

    expect(option(CARD_CAPTION), "the card option").toBeDefined();
    expect(option(SBP_CAPTION), "the SBP option").toBeDefined();
    expect(option(CAPTION), "a third, method-less option").toBeUndefined();
    // The ordinary payment: AntiloPay with its currency, no caption.
    expect(buttons().some((candidate) => candidate.textContent?.includes("AntiloPay") && candidate.textContent.includes("RUB"))).toBe(true);
  });

  it.each([
    ["a term that is not one of Antilopay's periods", { days: 45 }],
    ["a one-time promo price", { price: { discountSource: "PURCHASE" } }],
    ["a price with kopecks", { price: { price: "299.90" } }],
  ])("offers neither for %s", async (_name, input) => {
    await mountPurchaseGateway(input);

    expect(option(CARD_CAPTION)).toBeUndefined();
    expect(option(SBP_CAPTION)).toBeUndefined();
  });

  it("offers neither until the operator's approval reaches the list", async () => {
    api.getEnabledGateways.mockResolvedValue([{ ...ANTILOPAY_WIRE, autopay: false }]);

    await mountPurchaseGateway();

    expect(option(CARD_CAPTION)).toBeUndefined();
    expect(option(SBP_CAPTION)).toBeUndefined();
  });

  it.each([
    ["CARD", CARD_CAPTION, CARD_HINT],
    ["SBP", SBP_CAPTION, SBP_HINT],
  ])("sends %s with the checkout, with its own hint on the quote", async (method, caption, hint) => {
    await mountPurchaseGateway();

    await tap(option(caption), `${method} option`);
    await waitUntil(() => buttons().some((candidate) => candidate.textContent?.trim() === PAY));
    expect(usePurchaseStore.getState().selectedGateway?.autopayMethod).toBe(method);
    expect(usePurchaseStore.getState().savePaymentMethodConsent).toBe(true);
    expect(text()).toContain(hint);

    await tap(buttons().find((candidate) => candidate.textContent?.trim() === PAY), "Pay");
    await waitUntil(() => navigate.mock.calls.length > 0);

    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    const call = api.createCheckout.mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual(["plan-p", 30, "ANTILOPAY"]);
    expect(call[5], "the consent that makes it a subscription").toBe(true);
    expect(call[7], "the payer's choice").toBe(method);
  }, 10_000);

  it("sends no method with the ordinary payment", async () => {
    await mountPurchaseGateway();

    const ordinary = buttons().find(
      (candidate) => candidate.textContent?.includes("AntiloPay") === true && candidate.textContent.includes("RUB"),
    );
    await tap(ordinary, "ordinary AntiloPay payment");
    await waitUntil(() => buttons().some((candidate) => candidate.textContent?.trim() === PAY));
    await tap(buttons().find((candidate) => candidate.textContent?.trim() === PAY), "Pay");
    await waitUntil(() => navigate.mock.calls.length > 0);

    const call = api.createCheckout.mock.calls[0]!;
    expect(call[5]).toBeUndefined();
    expect(call[7]).toBeUndefined();
  }, 10_000);
});

describe("the renewal page offers it twice too", () => {
  function options(days: number) {
    return {
      userId: "user-1",
      items: [
        {
          subscriptionId: "sub-a",
          planId: "plan-p",
          planName: "plan-p",
          durationDays: days,
          availableDurations: [{ id: `d-${days}`, days }],
          currency: "RUB",
          amount: "299",
          discountPercent: 0,
          renewable: true,
          requiresPlanSelection: false,
          warnings: [],
        },
      ],
      currency: "RUB",
      total: "299",
    };
  }

  async function mountRenewalGateway(days: number): Promise<void> {
    api.getRenewalOptions.mockResolvedValue(options(days));
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { id: "plan-p", name: "Plan P" } }],
    });
    api.getSubscriptionAddOns.mockResolvedValue([]);
    api.getAddOnEntitlements.mockResolvedValue([]);
    useRenewalStore.setState({
      step: "gateway",
      navDirection: "back",
      selectedSubscriptionIds: ["sub-a"],
      selectedPlans: {},
    });
    await mount(<RenewalPage />);
    await waitUntil(
      () =>
        text().includes("AntiloPay") &&
        queryClient.getQueryData(["renewal-options", {}, {}]) !== undefined &&
        api.getAllSubscriptions.mock.results.length > 0,
    );
    await settle();
  }

  it("shows a card option and an SBP option for a term Antilopay has a period for", async () => {
    await mountRenewalGateway(30);

    expect(option(CARD_CAPTION)).toBeDefined();
    expect(option(SBP_CAPTION)).toBeDefined();
  });

  it("shows neither for a term it has no period for", async () => {
    await mountRenewalGateway(45);

    expect(text()).toContain("AntiloPay");
    expect(option(CARD_CAPTION)).toBeUndefined();
    expect(option(SBP_CAPTION)).toBeUndefined();
  });

  it.each([
    ["CARD", CARD_CAPTION],
    ["SBP", SBP_CAPTION],
  ])("keeps %s as the payer's choice on the way to the review", async (method, caption) => {
    await mountRenewalGateway(30);

    await tap(option(caption), `${method} option`);

    const gateway = useRenewalStore.getState().selectedGateway;
    expect(gateway?.autopay).toBe(true);
    expect(gateway?.autopayMethod).toBe(method);
    expect(useRenewalStore.getState().savePaymentMethodConsent).toBe(true);
  });
});

describe("a refusal of automatic charging says the truth", () => {
  const refusal = (reason: string) => ({
    response: { data: { code: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", message: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", reason } },
  });

  it("on a purchase: an approval that is off is «сейчас недоступно», any other reason «для этой покупки»", async () => {
    for (const [reason, key] of [
      ["NOT_APPROVED", "purchase.checkout.autopayUnavailableNow"],
      ["DURATION", "purchase.checkout.autopayNotAvailable"],
    ] as const) {
      api.createCheckout.mockReset();
      api.createCheckout.mockRejectedValue(refusal(reason));
      toast.error.mockClear();
      await mountPurchaseGateway();

      await tap(option(SBP_CAPTION), "SBP option");
      await waitUntil(() => buttons().some((candidate) => candidate.textContent?.trim() === PAY));
      await tap(buttons().find((candidate) => candidate.textContent?.trim() === PAY), "Pay");
      await waitUntil(() => toast.error.mock.calls.length > 0);

      expect(toast.error, reason).toHaveBeenCalledWith(key);
      expect(usePurchaseStore.getState().step, "back to the quote, where the ordinary payment is").toBe("quote");
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
      usePurchaseStore.getState().reset();
    }
  }, 20_000);

  it("on a renewal too, and the payer's choice went with the request", async () => {
    api.createRenewalCheckout.mockRejectedValue(refusal("NOT_APPROVED"));
    api.getRenewalOptions.mockResolvedValue({ userId: "user-1", items: [], currency: "RUB", total: "299" });
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.getSubscriptionAddOns.mockResolvedValue([]);
    api.getAddOnEntitlements.mockResolvedValue([]);
    useRenewalStore.setState({
      step: "checkout",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedDurations: {},
      selectedPlans: {},
      selectedGateway: { id: "ANTILOPAY", label: "AntiloPay", icon: "", currency: "RUB", autopay: true, autopayMethod: "CARD" },
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: true,
      reviewQuote: { amount: "299", currency: "RUB" },
    });

    await mount(<RenewalPage />);
    await waitUntil(() => toast.error.mock.calls.length > 0);

    expect(toast.error).toHaveBeenCalledWith("purchase.checkout.autopayUnavailableNow");
    const call = api.createRenewalCheckout.mock.calls[0]!;
    expect(call[1]).toBe("ANTILOPAY");
    expect(call[8], "the consent that makes it a subscription").toBe(true);
    expect(call[9], "the payer's choice").toBe("CARD");
    expect(useRenewalStore.getState().step, "back to choosing the payment").toBe("gateway");
  }, 15_000);
});
