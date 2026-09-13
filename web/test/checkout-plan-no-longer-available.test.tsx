// @vitest-environment jsdom

/**
 * A plan the panel stopped selling must not strand the subscriber mid-wizard.
 *
 * The service worker and React Query both keep the catalogue, so a subscriber
 * can pick a plan an operator has since archived or deleted. The panel refuses
 * that checkout before any charge — `400 PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE`,
 * forwarded by the BFF — and the purchase page answered with a generic toast
 * over a "Создаём платёж…" spinner that never stopped.
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
import { act, type ComponentProps, type ReactNode } from "react";
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
  return Object.assign(new Error("Request failed with status code 400"), {
    isAxiosError: true,
    response: {
      status: 400,
      data: {
        code: "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE",
        message: "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE",
      },
    },
  });
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

describe("purchase: the panel refuses the plan at checkout", () => {
  function enterCheckout(): void {
    usePurchaseStore.setState({
      step: "checkout",
      selectedPlan: { id: "plan-archived", name: "Archived", type: "BOTH", durations: [] } as never,
      selectedDuration: { days: 30 } as never,
      selectedGateway: GATEWAY,
      selectedDevice: null,
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: false,
    });
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
    }
    expect(en.purchase.checkout.planUnavailable).not.toBe(ru.purchase.checkout.planUnavailable);
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
    // What the review re-reads once the target is gone.
    api.getQuote.mockResolvedValue({ warning: "PLAN_NOT_AVAILABLE" });
  });

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
