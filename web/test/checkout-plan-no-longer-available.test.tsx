// @vitest-environment jsdom

/**
 * A plan the panel stopped selling must not strand the subscriber mid-wizard.
 *
 * React Query keeps the catalogue, so a subscriber can pick a plan an operator
 * has since archived or deleted. The panel refuses that checkout before any
 * charge — `400 PAYMENT_DRAFT_PLAN_NOT_AVAILABLE`, or from a panel that predates
 * that code the generic `PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE`, forwarded by the BFF
 * — and the purchase page answered with a generic toast over a "Создаём
 * платёж…" spinner that never stopped. More often the quote itself finds the
 * plan gone, and said only "try a different payment method".
 *
 * Mounted the way the app mounts the wizard (store advanced into the step, a
 * query client with the app's defaults), because every one of these defects
 * lives in the hand-off between steps rather than in any single component.
 */

import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, StrictMode, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  createUpgradeCheckout: vi.fn(),
  createRenewalCheckout: vi.fn(),
  getActionPolicy: vi.fn(),
  getQuote: vi.fn(),
  getEnabledGateways: vi.fn(),
  getUpgradeOptions: vi.fn(),
  getRenewalOptions: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
  getAddOnEntitlements: vi.fn(),
  getPlans: vi.fn(),
  getPaymentMethods: vi.fn(),
  activatePromocode: vi.fn(),
  getPartnerInfo: vi.fn(),
  payWithPartnerBalance: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  },
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
  useRenewalAddOnsEnabled: () => false,
}));
// Both cards pull in WebGL effect layers and branding context. Plain buttons
// keep the spec about the wizard's decisions while the tap path stays real.
vi.mock("../src/features/plans/tariff-card", () => ({
  TariffCard: ({ plan, onClick }: { plan: { name: string }; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {plan.name}
    </button>
  ),
}));
vi.mock("@/components/subscription/subscription-select-card", () => ({
  SubscriptionSelectCard: ({
    subtitle,
    trailing,
    onSelect,
  }: {
    subtitle?: string;
    trailing?: ReactNode;
    onSelect: () => void;
  }) => (
    <div>
      <button type="button" onClick={onSelect}>
        {subtitle}
      </button>
      {trailing}
    </div>
  ),
}));

import PurchasePage from "../src/features/purchase/purchase-page";
import RenewalPage from "../src/features/renewal/renewal-page";
import UpgradePage from "../src/features/upgrade/upgrade-page";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { usePurchaseStore } from "../src/stores/purchase.store";
import { useRenewalStore } from "../src/stores/renewal.store";
import { useUpgradeStore } from "../src/stores/upgrade.store";

/** What the BFF sends when the panel refuses a plan it no longer sells. */
function planRefusal(): Error {
  return refusal("PAYMENT_DRAFT_PLAN_NOT_AVAILABLE");
}

/**
 * The panel's refusal that does not say why: any other ineligible quote — and,
 * from a panel older than PAYMENT_DRAFT_PLAN_NOT_AVAILABLE, a withdrawn plan too.
 */
function quoteNotEligibleRefusal(): Error {
  return refusal("PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE");
}

function refusal(code: string): Error {
  return Object.assign(new Error("Request failed with status code 400"), {
    isAxiosError: true,
    response: { status: 400, data: { code, message: code } },
  });
}

/** An unpriced quote as the BFF flattens it: the first code, and all of them. */
function unpricedQuote(...codes: string[]): { warning: string; warnings: { code: string; message: string }[] } {
  return { warning: codes[0]!, warnings: codes.map((code) => ({ code, message: code })) };
}

/** A priced quote as the BFF flattens it. */
function pricedQuote(planName: string): Record<string, unknown> {
  return {
    planId: "plan-archived",
    planName,
    durationDays: 30,
    currency: "RUB",
    basePrice: 100,
    finalPrice: 100,
    discountPercent: 0,
    gatewayType: "YOOKASSA",
  };
}

/** Buttons on screen, by their exact label. */
function buttonLabels(): string[] {
  return [...(container?.querySelectorAll("button") ?? [])].map((button) => button.textContent?.trim() ?? "");
}

/** Any other failure, which must not be mistaken for a withdrawn plan. */
function genericFailure(): Error {
  return Object.assign(new Error("Request failed with status code 500"), {
    isAxiosError: true,
    response: { status: 500, data: { message: "Failed to create checkout" } },
  });
}

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
/** The same gateway as `GET /gateways` returns it. */
const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };

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

/** Presses the on-screen button with exactly this label, as the subscriber would. */
async function press(label: string): Promise<void> {
  const target = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`no "${label}" button on screen; it shows: ${text()}`);
  act(() => target.click());
  await settle();
  await settle();
}

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  await settle();
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Microtasks drain ahead of timers, so React Query's notifications land
  // inside the open act scope — same reason as `plans-page-at-capacity`.
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  // The app's own defaults (`lib/query-client.ts`), minus retries: a staleness
  // bug that a zero staleTime would paper over must still show up here.
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
  });
  api.getPartnerInfo.mockResolvedValue(null);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  usePurchaseStore.getState().reset();
  useUpgradeStore.getState().reset();
  useRenewalStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Opens the purchase wizard on `step` with a plan, term and gateway chosen. */
function enterPurchase(step: "quote" | "checkout", plan: { readonly isTrial?: boolean } = {}): void {
  usePurchaseStore.setState({
    step,
    lastNav: "forward",
    selectedPlan: {
      id: "plan-archived",
      name: "Archived",
      type: "BOTH",
      durations: [],
      isTrial: plan.isTrial ?? false,
    } as never,
    selectedDuration: { days: 30 } as never,
    selectedGateway: GATEWAY,
    selectedDevice: null,
    selectedSavedPaymentMethodId: null,
    savePaymentMethodConsent: false,
  });
}

describe("purchase: the panel refuses the plan at checkout", () => {
  function enterCheckout(): void {
    enterPurchase("checkout");
  }

  it("stops the spinner, says the plan is gone and returns to plan selection", async () => {
    api.createCheckout.mockRejectedValueOnce(planRefusal());
    enterCheckout();

    await mount(<PurchasePage />);

    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    expect(text(), "the spinner is still up after the refusal").not.toContain(
      "purchase.checkout.creating",
    );
    expect(toast.warning).toHaveBeenCalledWith("purchase.checkout.planUnavailable", expect.anything());
    expect(toast.error, "a withdrawn plan is not a generic failure").not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/plans", { replace: true });
    expect(usePurchaseStore.getState().selectedPlan).toBeNull();
  });

  it("drops the catalogue that offered the withdrawn plan, so /plans refetches it", async () => {
    // Seeded as the plans page leaves it: fresh for five minutes, withdrawn plan
    // included. Merely invalidating would still RENDER this list while the
    // refetch runs, putting the same dead plan back under the subscriber's tap.
    queryClient.setQueryData(["plans"], [{ id: "plan-archived" }, { id: "plan-live" }]);
    api.createCheckout.mockRejectedValueOnce(planRefusal());
    enterCheckout();

    await mount(<PurchasePage />);

    expect(queryClient.getQueryData(["plans"])).toBeUndefined();
  });

  it("keeps an unrelated checkout failure away from plan selection", async () => {
    api.createCheckout.mockRejectedValueOnce(genericFailure());
    queryClient.setQueryData(["plans"], [{ id: "plan-archived" }]);
    enterCheckout();

    await mount(<PurchasePage />);

    expect(toast.error).toHaveBeenCalledWith("purchase.checkout.error");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith("/plans", expect.anything());
    expect(usePurchaseStore.getState().selectedPlan).not.toBeNull();
    expect(queryClient.getQueryData(["plans"])).toEqual([{ id: "plan-archived" }]);
  });

  it("does not leave the spinner up after an unrelated failure: back to the quote, choices kept", async () => {
    api.createCheckout.mockRejectedValueOnce(genericFailure());
    // The quote step re-prices on arrival; held open so this spec is about the hand-off.
    api.getQuote.mockReturnValue(new Promise(() => undefined));
    enterCheckout();

    await mount(<PurchasePage />);

    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("purchase.checkout.error");
    // The checkout step never retries by itself, so staying on it after the toast
    // was a spinner for good. On the quote the buyer can pay again or pick
    // another gateway, with everything they chose still selected.
    expect(usePurchaseStore.getState().step).toBe("quote");
    expect(usePurchaseStore.getState().selectedGateway).toEqual(GATEWAY);
    expect(usePurchaseStore.getState().selectedPlan).not.toBeNull();
    expect(text(), "the checkout spinner is still up").not.toContain("purchase.checkout.creating");
  });

  it("carries the notice in BOTH locales, and it is not the generic failure", () => {
    // `en` is typed `RuDict`, so a missing English key is a compile error — but
    // nothing at runtime stops the two from being empty or pasted from the
    // "try again later" line, which would send a buyer back to retry a plan
    // that no longer exists.
    for (const [name, dict] of [
      ["en", en],
      ["ru", ru],
    ] as const) {
      expect(dict.purchase.checkout.planUnavailable, `${name} copy`).toBeTruthy();
      expect(dict.purchase.checkout.planUnavailable).not.toBe(dict.purchase.checkout.error);
      expect(dict.purchase.checkout.notAccepted, `${name} copy`).toBeTruthy();
      expect(dict.purchase.checkout.notAccepted).not.toBe(dict.purchase.checkout.planUnavailable);
      expect(dict.purchase.checkout.notAccepted).not.toBe(dict.purchase.checkout.error);
    }
    expect(en.purchase.checkout.planUnavailable).not.toBe(ru.purchase.checkout.planUnavailable);
    expect(en.purchase.checkout.notAccepted).not.toBe(ru.purchase.checkout.notAccepted);
  });
});

describe("purchase: a refusal that does not say why", () => {
  // PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE no longer means "withdrawn" on its own: the
  // panel names that case apart now. It still does from the panel in production
  // today, so the page re-prices and lets the fresh quote tell the cases apart.

  it("still ends on the refreshed plan list when the fresh quote finds the plan gone (an older panel)", async () => {
    queryClient.setQueryData(["plans"], [{ id: "plan-archived" }, { id: "plan-live" }]);
    api.createCheckout.mockRejectedValueOnce(quoteNotEligibleRefusal());
    api.getQuote.mockResolvedValue(unpricedQuote("PLAN_NOT_AVAILABLE"));
    enterPurchase("checkout");

    await mount(<PurchasePage />);
    await settle();

    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("purchase.checkout.planUnavailable", expect.anything());
    expect(toast.error, "a withdrawn plan is not a generic failure").not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/plans", { replace: true });
    expect(usePurchaseStore.getState().selectedPlan).toBeNull();
    expect(queryClient.getQueryData(["plans"])).toBeUndefined();
  });

  it("does not call a plan that is still on sale withdrawn, and does not offer the refused Pay again", async () => {
    queryClient.setQueryData(["plans"], [{ id: "plan-archived" }]);
    api.createCheckout.mockRejectedValueOnce(quoteNotEligibleRefusal());
    // The fresh quote prices the plan: the refusal is not about the list.
    api.getQuote.mockResolvedValue(pricedQuote("Archived"));
    enterPurchase("checkout");

    await mount(<PurchasePage />);
    await settle();

    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    expect(text()).toContain("purchase.checkout.notAccepted");
    expect(text(), "the spinner is still up").not.toContain("purchase.checkout.creating");
    expect(buttonLabels(), "the refused quote is offered for payment again").not.toContain("purchase.quote.pay");
    expect(buttonLabels()).toContain("purchase.quote.change");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith("/plans", expect.anything());
    expect(usePurchaseStore.getState().selectedPlan).not.toBeNull();
    expect(queryClient.getQueryData(["plans"])).toEqual([{ id: "plan-archived" }]);
  });

  it("re-prices before deciding: the refused copy is neither offered nor judged while the fresh quote is out", async () => {
    // The realistic path: the buyer saw a price, pressed Pay, and was refused.
    let answerFreshQuote: (quote: unknown) => void = () => undefined;
    api.getQuote
      .mockResolvedValueOnce(pricedQuote("Archived"))
      .mockImplementationOnce(() => new Promise((resolve) => (answerFreshQuote = resolve)));
    api.createCheckout.mockRejectedValueOnce(quoteNotEligibleRefusal());
    enterPurchase("quote");

    await mount(<PurchasePage />);
    await press("purchase.quote.pay");
    await settle();

    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    expect(usePurchaseStore.getState().step).toBe("quote");
    expect(text(), "judged the refused copy before re-pricing it").not.toContain("purchase.checkout.notAccepted");
    expect(buttonLabels(), "offered the refused copy for payment while re-pricing").not.toContain(
      "purchase.quote.pay",
    );

    await act(async () => answerFreshQuote(unpricedQuote("PLAN_NOT_AVAILABLE")));
    await settle();
    await settle();

    expect(toast.warning).toHaveBeenCalledWith("purchase.checkout.planUnavailable", expect.anything());
    expect(navigate).toHaveBeenCalledWith("/plans", { replace: true });
  });

  it("names why a paid trial is not sold to this subscriber instead of calling it withdrawn", async () => {
    // Still listed: the catalogue does not check the Telegram link, so
    // "choose from the updated list" would lead straight back to this trial.
    queryClient.setQueryData(["plans"], [{ id: "plan-archived" }]);
    api.createCheckout.mockRejectedValueOnce(quoteNotEligibleRefusal());
    api.getQuote.mockResolvedValue(unpricedQuote("TRIAL_REQUIRES_TELEGRAM", "PLAN_NOT_AVAILABLE"));
    enterPurchase("checkout", { isTrial: true });

    await mount(<PurchasePage />);
    await settle();

    expect(text()).toContain("trialCta.subtitleLinkTelegram");
    expect(text()).not.toContain("purchase.quote.priceError");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith("/plans", expect.anything());
    expect(queryClient.getQueryData(["plans"])).toEqual([{ id: "plan-archived" }]);

    await press("trialCta.buttonLinkTelegram");
    expect(navigate).toHaveBeenCalledWith("/settings/privacy?link=telegram");
  });
});

describe("purchase: the quote finds the plan already gone", () => {
  // The most common path: the plan was withdrawn BEFORE the quote was priced, so
  // no checkout is ever refused — the quote itself says so.

  for (const codes of [
    ["PLAN_NOT_AVAILABLE"],
    ["DURATION_NOT_AVAILABLE"],
    // An older panel led with a listed trial's claim warning on quotes for
    // every other plan; for a plan that is not a trial it explains nothing.
    ["TRIAL_REQUIRES_TELEGRAM", "PLAN_NOT_AVAILABLE"],
  ]) {
    it(`says so and returns to a freshly loaded plan list (${codes.join(" + ")})`, async () => {
      queryClient.setQueryData(["plans"], [{ id: "plan-archived" }, { id: "plan-live" }]);
      api.getQuote.mockResolvedValue(unpricedQuote(...codes));
      enterPurchase("quote");

      await mount(<PurchasePage />);
      await settle();

      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledWith("purchase.checkout.planUnavailable", expect.anything());
      expect(queryClient.getQueryData(["plans"]), "the list still offers the withdrawn plan").toBeUndefined();
      expect(navigate).toHaveBeenCalledWith("/plans", { replace: true });
      expect(usePurchaseStore.getState().selectedPlan).toBeNull();
      expect(text(), "told to try another payment method for a plan that is gone").not.toContain(
        "purchase.quote.priceError",
      );
    });
  }

  it("keeps the payment-method hint for a quote the chosen gateway cannot price", async () => {
    queryClient.setQueryData(["plans"], [{ id: "plan-archived" }]);
    api.getQuote.mockResolvedValue(unpricedQuote("GATEWAY_NOT_AVAILABLE"));
    enterPurchase("quote");

    await mount(<PurchasePage />);
    await settle();

    expect(text()).toContain("purchase.quote.priceError");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith("/plans", expect.anything());
    expect(queryClient.getQueryData(["plans"])).toEqual([{ id: "plan-archived" }]);
  });
});

describe("upgrade: a target plan that is no longer sold", () => {
  const GONE_TARGET = {
    id: "plan-gone",
    name: "Gone target",
    tag: null,
    type: "BOTH",
    trafficLimit: null,
    deviceLimit: 5,
    durations: [{ id: "d-30", days: 30 }],
  };
  const LIVE_TARGET = { ...GONE_TARGET, id: "plan-live", name: "Live target" };

  beforeEach(() => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
    // A review the chosen gateway cannot price; the cases about a withdrawn
    // target set their own answer.
    api.getQuote.mockResolvedValue(unpricedQuote("UPGRADE_RESETS_EXPIRY", "GATEWAY_NOT_AVAILABLE"));
  });

  /** The target list as the subscriber chose from it, and as the panel serves it now. */
  function serveTargetsAfterWithdrawal(): void {
    queryClient.setQueryData(["upgrade-options", "sub-1"], {
      subscriptionId: "sub-1",
      plans: [GONE_TARGET, LIVE_TARGET],
      warnings: [],
    });
    api.getUpgradeOptions.mockResolvedValue({
      subscriptionId: "sub-1",
      plans: [LIVE_TARGET],
      warnings: [],
    });
  }

  function expectBackOnRefreshedTargets(): void {
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("purchase.checkout.planUnavailable", expect.anything());
    expect(useUpgradeStore.getState().step).toBe("plan");
    expect(useUpgradeStore.getState().selectedPlan).toBeNull();
    expect(text(), "the target list was not refetched").toContain("Live target");
    expect(text()).not.toContain("Gone target");
  }

  /** Mount first, then advance: the page resets the store when it unmounts. */
  async function enterStep(step: "review" | "checkout"): Promise<void> {
    await mount(<UpgradePage />);
    act(() => {
      useUpgradeStore.setState({
        step,
        selectedSubscriptionId: "sub-1",
        selectedPlan: GONE_TARGET,
        selectedDurationDays: 30,
        selectedGateway: GATEWAY,
      });
    });
    await settle();
    await settle();
  }

  it("sends a refused checkout back to the refreshed target list", async () => {
    // The list the subscriber chose from, still holding the withdrawn target.
    queryClient.setQueryData(["upgrade-options", "sub-1"], {
      subscriptionId: "sub-1",
      plans: [GONE_TARGET, LIVE_TARGET],
      warnings: [],
    });
    api.getUpgradeOptions.mockResolvedValue({
      subscriptionId: "sub-1",
      plans: [LIVE_TARGET],
      warnings: [],
    });
    api.createUpgradeCheckout.mockRejectedValueOnce(planRefusal());

    await enterStep("checkout");

    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("upgrade.creating");
    expect(toast.warning).toHaveBeenCalledWith("purchase.checkout.planUnavailable", expect.anything());
    expect(useUpgradeStore.getState().step).toBe("plan");
    expect(useUpgradeStore.getState().selectedPlan).toBeNull();
    expect(text(), "the target list was not refetched").toContain("Live target");
    expect(text()).not.toContain("Gone target");
  });

  it("sends an older panel's bare refusal back to the refreshed target list once the review finds it gone", async () => {
    serveTargetsAfterWithdrawal();
    api.createUpgradeCheckout.mockRejectedValueOnce(quoteNotEligibleRefusal());
    // An upgrade quote leads with its informational warning, so the withdrawal
    // is only visible in the full list.
    api.getQuote.mockResolvedValue(unpricedQuote("UPGRADE_RESETS_EXPIRY", "PLAN_NOT_AVAILABLE"));

    await enterStep("checkout");
    await settle();

    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expectBackOnRefreshedTargets();
  });

  it("re-prices a refused review before deciding, instead of judging the copy it already showed", async () => {
    // The realistic path: the subscriber saw the upgrade priced and pressed Pay.
    serveTargetsAfterWithdrawal();
    let answerFreshQuote: (quote: unknown) => void = () => undefined;
    api.getQuote
      .mockResolvedValueOnce({
        planId: "plan-gone",
        planName: "Gone target",
        durationDays: 30,
        currency: "RUB",
        basePrice: 100,
        finalPrice: 100,
        discountPercent: 0,
        gatewayType: "YOOKASSA",
      })
      .mockImplementationOnce(() => new Promise((resolve) => (answerFreshQuote = resolve)));
    api.createUpgradeCheckout.mockRejectedValueOnce(quoteNotEligibleRefusal());

    await enterStep("review");
    await press("upgrade.pay");
    await settle();

    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    expect(useUpgradeStore.getState().step).toBe("review");
    expect(text(), "judged the refused copy before re-pricing it").not.toContain("purchase.checkout.notAccepted");
    expect(buttonLabels()).not.toContain("upgrade.pay");

    await act(async () => answerFreshQuote(unpricedQuote("UPGRADE_RESETS_EXPIRY", "PLAN_NOT_AVAILABLE")));
    await settle();
    await settle();

    expectBackOnRefreshedTargets();
  });

  it("returns to the refreshed target list when the review finds the target already gone", async () => {
    serveTargetsAfterWithdrawal();
    api.getQuote.mockResolvedValue(unpricedQuote("UPGRADE_RESETS_EXPIRY", "PLAN_NOT_AVAILABLE"));

    await enterStep("review");
    await settle();

    expect(text(), "told to try another payment method for a target that is gone").not.toContain(
      "upgrade.priceError",
    );
    expectBackOnRefreshedTargets();
  });

  it("does not offer Pay again for a priced upgrade the panel refused without saying why", async () => {
    api.createUpgradeCheckout.mockRejectedValueOnce(quoteNotEligibleRefusal());
    api.getQuote.mockResolvedValue({
      planId: "plan-gone",
      planName: "Gone target",
      durationDays: 30,
      currency: "RUB",
      basePrice: 100,
      finalPrice: 100,
      discountPercent: 0,
      gatewayType: "YOOKASSA",
    });

    await enterStep("checkout");
    await settle();

    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    expect(useUpgradeStore.getState().step).toBe("review");
    expect(text()).toContain("purchase.checkout.notAccepted");
    expect(buttonLabels()).not.toContain("upgrade.pay");
    expect(buttonLabels()).toContain("upgrade.change");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("lets Back leave a review that cannot be priced when only one gateway exists", async () => {
    // The trap: Back from the price error lands on the gateway step, which
    // auto-selects the single gateway and lands straight back on the error.
    await enterStep("review");
    expect(text()).toContain("upgrade.priceError");

    await press("upgrade.back");

    expect(useUpgradeStore.getState().step, "Back bounced straight into the review").toBe("gateway");
    expect(text()).toContain("purchase.gateway.title");

    // And one more step back still goes back, rather than re-advancing from
    // a single-term duration step.
    await press("upgrade.back");
    expect(useUpgradeStore.getState().step).toBe("duration");
  });
});

describe("renewal: a plan chosen for a plan-less subscription that is no longer sold", () => {
  const PLAN_GONE = { id: "plan-gone", name: "Gone plan", isTrial: false, durations: [{ id: "d-30", days: 30 }] };
  const PLAN_LIVE = { id: "plan-live", name: "Live plan", isTrial: false, durations: [{ id: "d-30", days: 30 }] };

  /** The panel's item for a panel-imported subscription with no plan of its own. */
  const NEEDS_PLAN = {
    subscriptionId: "sub-1",
    planId: null,
    planName: null,
    durationDays: null,
    availableDurations: [],
    currency: null,
    amount: null,
    discountPercent: 0,
    renewable: true,
    requiresPlanSelection: true,
    warnings: [{ code: "PLAN_SELECTION_REQUIRED", message: "A plan must be selected." }],
  };
  /** `quoteSubscriptionRenewal` when the chosen plan is not among the targets. */
  const CHOICE_WITHDRAWN = { ...NEEDS_PLAN, renewable: false, requiresPlanSelection: false };

  /** Plans the panel has stopped selling since the catalogue was fetched. */
  let withdrawn: Set<string>;

  beforeEach(() => {
    withdrawn = new Set(["plan-gone"]);
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-1", status: "ACTIVE", isTrial: false, plan: null }],
    });
    api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
    api.getRenewalOptions.mockImplementation(
      async (input?: { plans?: { subscriptionId: string; planId: string }[] }) => {
        const chosen = input?.plans?.find((entry) => entry.subscriptionId === "sub-1")?.planId;
        if (chosen === undefined) return { items: [NEEDS_PLAN], currency: null, total: null };
        if (withdrawn.has(chosen)) return { items: [CHOICE_WITHDRAWN], currency: null, total: null };
        return {
          items: [
            {
              ...NEEDS_PLAN,
              planId: chosen,
              planName: "Live plan",
              durationDays: 30,
              availableDurations: [{ id: "d-30", days: 30 }],
              currency: "RUB",
              amount: "100",
              requiresPlanSelection: false,
              warnings: [],
            },
          ],
          currency: "RUB",
          total: "100",
        };
      },
    );
    // First read is the catalogue as the service worker kept it; every later
    // read is what the panel sells now.
    api.getPlans.mockResolvedValueOnce([PLAN_GONE, PLAN_LIVE]).mockResolvedValue([PLAN_LIVE]);
  });

  async function openRenewal(): Promise<void> {
    await mount(<RenewalPage />);
    await settle();
    // One plan-less subscription: the wizard selects it and opens the plan step.
    expect(useRenewalStore.getState().step).toBe("plan");
  }

  function expectOnePlanUnavailableNotice(): void {
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0]?.[0]).toBe("purchase.checkout.planUnavailable");
  }

  it("returns the subscriber from the review to the refreshed plan list", async () => {
    await openRenewal();
    await press("Gone plan");
    await press("renewal.continue");
    await settle();

    expect(useRenewalStore.getState().step, "stuck on a review that cannot be priced").toBe("plan");
    expect(useRenewalStore.getState().selectedPlans).toEqual({});
    expectOnePlanUnavailableNotice();
    expect(text(), "the plan list was not refetched").toContain("Live plan");
    expect(text()).not.toContain("Gone plan");
  });

  it("does not strand the subscription as unrenewable after Back from the plan step", async () => {
    await openRenewal();
    await press("Gone plan");
    await press("renewal.back");
    await settle();

    expect(text(), "the subscription list dead-ends").not.toContain("renewal.noneRenewable");
    expect(useRenewalStore.getState().selectedPlans).toEqual({});
    expect(text()).toContain("renewal.choosePlanCta");
    expectOnePlanUnavailableNotice();

    await press("renewal.continue");
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(text()).toContain("Live plan");
    expect(text()).not.toContain("Gone plan");
  });

  it("re-prices after a refused checkout instead of re-offering the refused quote", async () => {
    withdrawn = new Set();
    // The operator withdraws the plan while the subscriber is on the review;
    // the panel refuses the checkout, which the BFF can only report as a 500.
    api.createRenewalCheckout.mockImplementation(async () => {
      withdrawn.add("plan-live");
      throw genericFailure();
    });

    await openRenewal();
    await press("Live plan");
    await press("renewal.continue");
    await settle();
    expect(text()).toContain("renewal.pay");

    await press("renewal.pay");
    await settle();
    await settle();

    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(1);
    expect(
      useRenewalStore.getState().step,
      "a refused checkout did not lead back to plan selection",
    ).toBe("plan");
    expect(text()).not.toContain("renewal.pay");
    expect(useRenewalStore.getState().selectedPlans).toEqual({});
    expect(toast.warning.mock.calls.map((call) => call[0])).toContain("purchase.checkout.planUnavailable");
  });
});

describe("renewal: a subscription whose OWN plan is deleted mid-flow", () => {
  // Deleting a plan makes its subscriptions ask for a plan choice at renewal
  // (renewable, requiresPlanSelection, no price). The review summed only the
  // priced subscriptions, offered Pay for that total, and every Pay was refused
  // (RENEWAL_ITEM_NOT_PRICEABLE) — nothing said a plan had to be chosen.
  const PLAN_LIVE = { id: "plan-live", name: "Live plan", isTrial: false, durations: [{ id: "d-30", days: 30 }] };

  function pricedItem(subscriptionId: string, planId: string, amount: string) {
    return {
      subscriptionId,
      planId,
      planName: planId,
      durationDays: 30,
      availableDurations: [{ id: "d-30", days: 30 }],
      currency: "RUB",
      amount,
      discountPercent: 0,
      renewable: true,
      requiresPlanSelection: false,
      warnings: [],
    };
  }

  /** `quoteSubscriptionRenewal` for a subscription whose plan is gone and no choice was sent. */
  function needsChoiceItem(subscriptionId: string) {
    return {
      subscriptionId,
      planId: null,
      planName: null,
      durationDays: null,
      availableDurations: [],
      currency: null,
      amount: null,
      discountPercent: 0,
      renewable: true,
      requiresPlanSelection: true,
      warnings: [{ code: "ARCHIVED_PLAN_REPLACEMENT", message: "archived" }],
    };
  }

  /** Whether the operator has deleted plan P (sub-a's own plan) yet. */
  let planDeleted: boolean;

  beforeEach(() => {
    planDeleted = true;
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [
        { id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } },
        { id: "sub-b", status: "ACTIVE", isTrial: false, plan: { name: "R" } },
      ],
    });
    api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
    api.getPlans.mockResolvedValue([PLAN_LIVE]);
    api.getRenewalOptions.mockImplementation(
      async (input?: { subscriptionIds?: string[]; plans?: { subscriptionId: string; planId: string }[] }) => {
        const chosenForA = input?.plans?.find((entry) => entry.subscriptionId === "sub-a")?.planId;
        const itemA =
          chosenForA !== undefined
            ? pricedItem("sub-a", chosenForA, "100")
            : planDeleted
              ? needsChoiceItem("sub-a")
              : pricedItem("sub-a", "plan-p", "200");
        const items = [itemA, pricedItem("sub-b", "plan-r", "300")].filter(
          (item) => input?.subscriptionIds === undefined || input.subscriptionIds.includes(item.subscriptionId),
        );
        const priced = items.filter((item) => item.amount !== null);
        const total = priced.reduce((sum, item) => sum + Number(item.amount), 0);
        return {
          userId: "user-1",
          items,
          currency: priced.length > 0 ? "RUB" : null,
          total: priced.length > 0 ? String(total) : null,
        };
      },
    );
  });

  function priceNotRenewable(): Error {
    return Object.assign(new Error("Request failed with status code 409"), {
      isAxiosError: true,
      response: {
        status: 409,
        data: {
          code: "RENEWAL_ITEM_NOT_PRICEABLE",
          message: "A subscription can no longer be renewed on these terms. Review the renewal again.",
        },
      },
    });
  }

  it("sends a multi-subscription review to choose a plan instead of offering Pay for part of it", async () => {
    // The list the subscriber ticked, as React Query still holds it: sub-a on
    // its own plan, priced. Plan selection reads it too, and must not skip past
    // the choice on this copy.
    queryClient.setQueryData(["renewal-options", {}, {}], {
      userId: "user-1",
      items: [pricedItem("sub-a", "plan-p", "200"), pricedItem("sub-b", "plan-r", "300")],
      currency: "RUB",
      total: "500",
    });
    // The catalogue as it was cached before P was deleted.
    queryClient.setQueryData(["plans"], [
      { id: "plan-p", name: "Deleted plan P", isTrial: false, durations: [{ id: "d-30", days: 30 }] },
      PLAN_LIVE,
    ]);
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a", "sub-b"],
      selectedGateway: GATEWAY,
    });

    await mount(<RenewalPage />);
    await settle();
    await settle();

    expect(useRenewalStore.getState().step, "offered Pay for a total without sub-a").toBe("plan");
    expect(api.createRenewalCheckout).not.toHaveBeenCalled();
    expect(buttonLabels()).not.toContain("renewal.pay");
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("purchase.checkout.planUnavailable", expect.anything());
    expect(text(), "plan selection skipped the choice on the stale list").toContain("Live plan");
    expect(text(), "the deleted plan is offered to choose").not.toContain("Deleted plan P");

    // And the way on works: choose, continue, and the review prices both.
    await press("Live plan");
    await press("renewal.continue");
    await settle();
    expect(useRenewalStore.getState().step).toBe("review");
    expect(buttonLabels()).toContain("renewal.pay");
    expect(text()).toContain("400");
  });

  it("sends a refused Pay to plan choice when the subscription's plan was deleted after the review", async () => {
    planDeleted = false;
    api.createRenewalCheckout.mockImplementation(async () => {
      planDeleted = true;
      throw priceNotRenewable();
    });
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedGateway: GATEWAY,
    });

    await mount(<RenewalPage />);
    expect(buttonLabels()).toContain("renewal.pay");

    await press("renewal.pay");
    await settle();
    await settle();

    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(1);
    expect(useRenewalStore.getState().step, "the re-priced review dead-ends").toBe("plan");
    expect(text()).not.toContain("renewal.priceError");
    expect(text()).toContain("Live plan");
    expect(toast.warning.mock.calls.map((call) => call[0])).toContain("purchase.checkout.planUnavailable");
  });
});

describe("under StrictMode, a withdrawal the step meets on mount is announced once", () => {
  // `main.tsx` renders the app in StrictMode, which runs a newly mounted
  // component's effects twice. A cached answer is there on the first render, so
  // the withdrawal is met inside that double run.
  async function mountStrict(node: ReactNode): Promise<void> {
    await mount(<StrictMode>{node}</StrictMode>);
  }

  it("purchase quote", async () => {
    queryClient.setQueryData(["quote", "plan-archived", 30, "YOOKASSA"], unpricedQuote("PLAN_NOT_AVAILABLE"));
    enterPurchase("quote");

    await mountStrict(<PurchasePage />);

    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("upgrade review", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
    api.getUpgradeOptions.mockResolvedValue({ subscriptionId: "sub-1", plans: [], warnings: [] });
    queryClient.setQueryData(
      ["upgrade-quote", "sub-1", "plan-gone", 30, "YOOKASSA"],
      unpricedQuote("UPGRADE_RESETS_EXPIRY", "PLAN_NOT_AVAILABLE"),
    );
    // Mount first: the page resets its store when it (StrictMode-)unmounts.
    await mountStrict(<UpgradePage />);
    act(() => {
      useUpgradeStore.setState({
        step: "review",
        selectedSubscriptionId: "sub-1",
        selectedPlan: { id: "plan-gone", name: "Gone", durations: [{ id: "d-30", days: 30 }] } as never,
        selectedDurationDays: 30,
        selectedGateway: GATEWAY,
      });
    });
    await settle();
    await settle();

    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("renewal review", async () => {
    // The review now re-prices on every visit and acts only on that answer, so
    // the double run on mount never sees this cached copy: what this pins is the
    // outcome, one notice. It no longer isolates `useSendToPlanChoice`'s latch,
    // which no mount reaches (renewal-plan-choice-handoff.test.tsx pins the
    // re-price itself).
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: null }],
    });
    api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
    api.getPlans.mockResolvedValue([]);
    const needsChoice = {
      subscriptionId: "sub-a",
      planId: null,
      planName: null,
      durationDays: null,
      availableDurations: [],
      currency: null,
      amount: null,
      discountPercent: 0,
      renewable: true,
      requiresPlanSelection: true,
      warnings: [],
    };
    api.getRenewalOptions.mockResolvedValue({ userId: "user-1", items: [needsChoice], currency: null, total: null });
    queryClient.setQueryData(["renewal-review", ["sub-a"], "YOOKASSA", {}, {}], {
      userId: "user-1",
      items: [needsChoice],
      currency: null,
      total: null,
    });
    await mountStrict(<RenewalPage />);
    act(() => {
      useRenewalStore.setState({
        step: "review",
        navDirection: "forward",
        selectedSubscriptionIds: ["sub-a"],
        selectedGateway: GATEWAY,
      });
    });
    await settle();
    await settle();

    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});
