// @vitest-environment jsdom

/**
 * «Отсрочка первого списания по СБП» on the real purchase and renewal pages.
 *
 * The operator can give an Antilopay SBP subscription a delay: nothing is
 * charged when the customer signs up, the plan is theirs for the delay at once,
 * and the first charge comes after it. The panel names the delay on the
 * Antilopay entry of its list (`autopayDelay`), per customer. What the pages owe
 * the customer is a consent that is TRUE:
 *
 *   - the SBP option, and only it, says nothing is charged now and when the
 *     first charge comes; a card option is the card's, and an ordinary payment is
 *     ordinary;
 *   - the step before paying says it again, with the sum and the term;
 *   - the checkout carries back exactly the delay that was shown, and nothing when
 *     none was — so a panel that does not know the fields is never sent them;
 *   - a delay the panel no longer gives (its refusal `DELAY_CHANGED`) is told
 *     as it is, the list is read again, and the customer chooses anew.
 *
 * The api is mocked at the client module; `t` returns the key with its values,
 * so what each sentence is made of can be read off the screen.
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
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values === undefined ? key : `${key}${JSON.stringify(values)}`),
    i18n: { language: "ru" },
  }),
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
const SBP_CAPTION = "purchase.gateway.autopayCaptionSbp";
const CARD_CAPTION = "purchase.gateway.autopayCaptionCard";
const DELAY_CAPTION = "purchase.gateway.autopayCaptionSbpDelay";
const DELAY_CAPTION_SHORT = "purchase.gateway.autopayCaptionSbpDelayShort";
const DELAY_HINT = "purchase.quote.autopayDelayHint";
const SBP_HINT = "purchase.quote.autopayProviderHint";
/** What `t` prints for 7 days: the key and the count, before the page puts it in a sentence. */
const SEVEN_DAYS_TEXT = 'autopayDelay.duration.DAY{"count":7}';
/** And as it reads inside the JSON of the sentence that holds it: `"delay":<this>`. */
const DELAY_VALUE = `"delay":${JSON.stringify(SEVEN_DAYS_TEXT)}`;

const SEVEN_DAYS = { count: 7, unit: "DAY", days: 7 };
const ANTILOPAY_WIRE = {
  type: "ANTILOPAY",
  displayName: "AntiloPay",
  currency: "RUB",
  isActive: true,
  autopay: false,
  autopayMethods: ["CARD", "SBP"],
};
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

/** The AntiloPay row whose caption contains `caption`. */
function option(caption: string): HTMLButtonElement | undefined {
  return buttons().find(
    (candidate) => candidate.textContent?.includes("AntiloPay") === true && candidate.textContent.includes(caption),
  );
}

async function tap(target: HTMLButtonElement | undefined, what: string): Promise<void> {
  if (!target) throw new Error(`no ${what} on screen; it shows: ${text()}`);
  act(() => target.click());
  await settle();
}

function payButton(): HTMLButtonElement | undefined {
  return buttons().find((candidate) => candidate.textContent?.trim() === PAY);
}

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
}

async function mountPurchaseGateway(): Promise<void> {
  usePurchaseStore.setState({
    step: "gateway",
    lastNav: "forward",
    selectedPlan: { id: "plan-p", name: "Plan P", type: "BOTH", durations: [], isTrial: false } as never,
    selectedDuration: {
      id: "d-30",
      days: 30,
      prices: [{ currency: "RUB", price: "299", gatewayType: "ANTILOPAY", discountSource: "NONE" }],
    } as never,
    selectedGateway: null,
    selectedSavedPaymentMethodId: null,
    savePaymentMethodConsent: false,
  });
  await mount(<PurchasePage />);
  await waitUntil(() => text().includes("AntiloPay"));
  await settle();
}

async function payFrom(caption: string): Promise<unknown[]> {
  await tap(option(caption), `option ${caption}`);
  await waitUntil(() => payButton() !== undefined);
  await tap(payButton(), "Pay");
  await waitUntil(() => navigate.mock.calls.length > 0);
  expect(api.createCheckout).toHaveBeenCalledTimes(1);
  return api.createCheckout.mock.calls[0]!;
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
  api.getEnabledGateways.mockResolvedValue([{ ...ANTILOPAY_WIRE, autopayDelay: SEVEN_DAYS }]);
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

describe("the purchase page, for a customer offered the delay", () => {
  it("says on the SBP option, and only on it, that nothing is charged now", async () => {
    await mountPurchaseGateway();

    const sbp = option(DELAY_CAPTION);
    expect(sbp, "the SBP option").toBeDefined();
    // The delay in words and the sum of the first charge: both are in the caption.
    expect(sbp?.textContent).toContain(DELAY_VALUE);
    expect(sbp?.textContent).toContain("₽299.00 RUB");
    // The card's first payment is charged on the form: its caption is the card's.
    expect(option(CARD_CAPTION), "the card option").toBeDefined();
    expect(option(CARD_CAPTION)?.textContent).not.toContain(DELAY_CAPTION);
    // And no option carries the plain SBP caption beside it.
    expect(buttons().some((candidate) => candidate.textContent?.includes(`${SBP_CAPTION}`) === true && !candidate.textContent.includes(DELAY_CAPTION))).toBe(false);
    // The ordinary payment: AntiloPay with its currency, no caption.
    expect(
      buttons().some(
        (candidate) =>
          candidate.textContent?.includes("AntiloPay") === true &&
          candidate.textContent.includes("RUB") &&
          !candidate.textContent.includes("autopay"),
      ),
    ).toBe(true);
  });

  it("keeps the delay on the choice, says it again before paying with the sum and the term, and sends it with the checkout", async () => {
    await mountPurchaseGateway();

    await tap(option(DELAY_CAPTION), "SBP option");
    await waitUntil(() => payButton() !== undefined);

    expect(usePurchaseStore.getState().selectedGateway?.autopayMethod).toBe("SBP");
    expect(usePurchaseStore.getState().selectedGateway?.autopayDelay).toEqual(SEVEN_DAYS);
    expect(text()).toContain(DELAY_HINT);
    expect(text()).toContain(DELAY_VALUE);
    expect(text()).toContain('"amount":"₽299.00 RUB"');
    expect(text()).toContain('"term":"purchase.duration.days{\\"count\\":30}"');
    expect(text(), "not the ordinary SBP hint, which says the sum is charged now").not.toContain(SBP_HINT);

    await tap(payButton(), "Pay");
    await waitUntil(() => navigate.mock.calls.length > 0);
    const call = api.createCheckout.mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual(["plan-p", 30, "ANTILOPAY"]);
    expect(call[5], "the consent that makes it a subscription").toBe(true);
    expect(call[7], "the payer's choice").toBe("SBP");
    expect(call[8], "the delay that was shown, as a count and the panel's word").toEqual({ count: 7, unit: "DAY" });
    expect(call).toHaveLength(9);
  }, 10_000);

  it("sends a card sign-up no delay, though the list names one: its first payment is charged on the form", async () => {
    await mountPurchaseGateway();

    const call = await payFrom(CARD_CAPTION);

    expect(call[7]).toBe("CARD");
    expect(call).toHaveLength(8);
    expect(usePurchaseStore.getState().selectedGateway?.autopayDelay).toBeUndefined();
  }, 10_000);

  it("sends none with the ordinary payment either", async () => {
    await mountPurchaseGateway();

    const ordinary = buttons().find(
      (candidate) =>
        candidate.textContent?.includes("AntiloPay") === true &&
        candidate.textContent.includes("RUB") &&
        !candidate.textContent.includes("autopay"),
    );
    await tap(ordinary, "ordinary AntiloPay payment");
    await waitUntil(() => payButton() !== undefined);
    await tap(payButton(), "Pay");
    await waitUntil(() => navigate.mock.calls.length > 0);

    const call = api.createCheckout.mock.calls[0]!;
    expect(call[7]).toBeUndefined();
    expect(call[8]).toBeUndefined();
  }, 10_000);
});

describe("the purchase page, for a customer who is offered none", () => {
  it.each([
    ["a panel that names no delay (older, or the customer used it, or the cabinet is not on its list)", {}],
    ["a delay with a unit in the wrong case", { autopayDelay: { count: 7, unit: "day", days: 7 } }],
    ["a delay whose days do not match", { autopayDelay: { count: 7, unit: "DAY", days: 8 } }],
    ["a delay that is not an object", { autopayDelay: "7 DAY" }],
  ])("says the charge is made now, as it always did: %s", async (_name, extra) => {
    api.getEnabledGateways.mockResolvedValue([{ ...ANTILOPAY_WIRE, ...extra }]);
    await mountPurchaseGateway();

    expect(option(SBP_CAPTION), "the ordinary SBP option").toBeDefined();
    expect(option(DELAY_CAPTION)).toBeUndefined();

    const call = await payFrom(SBP_CAPTION);
    expect(call[7]).toBe("SBP");
    expect(call, "no delay is sent for a sign-up that was shown none").toHaveLength(8);
    expect(text()).not.toContain(DELAY_HINT);
  }, 10_000);
});

describe("when the panel no longer gives the delay the customer read", () => {
  it("tells it as it is, reads the list again, and sends the customer back to choose", async () => {
    api.createCheckout.mockRejectedValue({
      response: {
        data: { code: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", message: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", reason: "DELAY_CHANGED" },
      },
    });
    await mountPurchaseGateway();
    expect(api.getEnabledGateways).toHaveBeenCalledTimes(1);

    await tap(option(DELAY_CAPTION), "SBP option");
    await waitUntil(() => payButton() !== undefined);
    await tap(payButton(), "Pay");
    await waitUntil(() => toast.error.mock.calls.length > 0);

    expect(toast.error).toHaveBeenCalledWith("purchase.checkout.autopayDelayChanged");
    expect(usePurchaseStore.getState().step, "back to choosing the payment, not to the stale quote").toBe("gateway");
    await waitUntil(() => api.getEnabledGateways.mock.calls.length > 1);
    expect(navigate).not.toHaveBeenCalled();
  }, 15_000);
});

describe("the renewal page", () => {
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

  beforeEach(() => {
    api.getRenewalOptions.mockResolvedValue(options(30));
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { id: "plan-p", name: "Plan P" } }],
    });
    api.getSubscriptionAddOns.mockResolvedValue([]);
    api.getAddOnEntitlements.mockResolvedValue([]);
    api.createRenewalCheckout.mockResolvedValue({ paymentId: "pay-renew", checkoutUrl: null });
  });

  it("says on the SBP option that nothing is charged now, keeps the delay, and says it again at the review with the sum", async () => {
    useRenewalStore.setState({
      step: "gateway",
      navDirection: "back",
      selectedSubscriptionIds: ["sub-a"],
      selectedPlans: {},
    });
    await mount(<RenewalPage />);
    await waitUntil(
      () =>
        option(DELAY_CAPTION_SHORT) !== undefined &&
        queryClient.getQueryData(["renewal-options", {}, {}]) !== undefined &&
        api.getAllSubscriptions.mock.results.length > 0,
    );
    expect(option(DELAY_CAPTION_SHORT)?.textContent).toContain(DELAY_VALUE);
    expect(option(CARD_CAPTION)).toBeDefined();

    await tap(option(DELAY_CAPTION_SHORT), "SBP option");

    const gateway = useRenewalStore.getState().selectedGateway;
    expect(gateway?.autopayMethod).toBe("SBP");
    expect(gateway?.autopayDelay).toEqual(SEVEN_DAYS);
    await waitUntil(() => text().includes(DELAY_HINT));
    expect(text()).toContain(DELAY_VALUE);
    expect(text()).toContain("299");
    expect(text()).not.toContain(SBP_HINT);
  }, 15_000);

  it("sends the delay that was shown with the renewal checkout", async () => {
    useRenewalStore.setState({
      step: "checkout",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedDurations: {},
      selectedPlans: {},
      selectedGateway: {
        id: "ANTILOPAY",
        label: "AntiloPay",
        icon: "",
        currency: "RUB",
        autopay: true,
        autopayMethod: "SBP",
        autopayDelay: SEVEN_DAYS,
      } as never,
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: true,
      reviewQuote: { amount: "299", currency: "RUB" },
    });

    await mount(<RenewalPage />);
    await waitUntil(() => api.createRenewalCheckout.mock.calls.length > 0);

    const call = api.createRenewalCheckout.mock.calls[0]!;
    expect(call[1]).toBe("ANTILOPAY");
    expect(call[8], "the consent that makes it a subscription").toBe(true);
    expect(call[9], "the payer's choice").toBe("SBP");
    expect(call[10], "the delay that was shown").toEqual({ count: 7, unit: "DAY" });
    expect(call).toHaveLength(11);
  }, 15_000);

  it("sends no delay for a card, and a sign-up that was shown none keeps the shorter call", async () => {
    useRenewalStore.setState({
      step: "checkout",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedDurations: {},
      selectedPlans: {},
      selectedGateway: { id: "ANTILOPAY", label: "AntiloPay", icon: "", currency: "RUB", autopay: true, autopayMethod: "SBP" },
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: true,
      reviewQuote: { amount: "299", currency: "RUB" },
    });

    await mount(<RenewalPage />);
    await waitUntil(() => api.createRenewalCheckout.mock.calls.length > 0);

    const call = api.createRenewalCheckout.mock.calls[0]!;
    expect(call[9]).toBe("SBP");
    expect(call).toHaveLength(10);
  }, 15_000);

  it("tells a delay that is gone as it is, reads the list again, and goes back to choosing the payment", async () => {
    api.createRenewalCheckout.mockRejectedValue({
      response: {
        data: { code: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", message: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", reason: "DELAY_CHANGED" },
      },
    });
    useRenewalStore.setState({
      step: "checkout",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedDurations: {},
      selectedPlans: {},
      selectedGateway: {
        id: "ANTILOPAY",
        label: "AntiloPay",
        icon: "",
        currency: "RUB",
        autopay: true,
        autopayMethod: "SBP",
        autopayDelay: SEVEN_DAYS,
      } as never,
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: true,
      reviewQuote: { amount: "299", currency: "RUB" },
    });
    queryClient.setQueryData(["gateways"], [ANTILOPAY_WIRE]);

    await mount(<RenewalPage />);
    await waitUntil(() => toast.error.mock.calls.length > 0);

    expect(toast.error).toHaveBeenCalledWith("purchase.checkout.autopayDelayChanged");
    expect(useRenewalStore.getState().step).toBe("gateway");
    expect(queryClient.getQueryState(["gateways"])?.isInvalidated, "the list is read again").toBe(true);
  }, 15_000);
});
