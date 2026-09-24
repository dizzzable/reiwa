// @vitest-environment jsdom

/**
 * A SUBSCRIPTION WITH NO END DATE IS NOT OFFERED A RENEWAL (the owner,
 * 24.09.2026), on «Продление» itself.
 *
 * The panel refuses the checkout (`SUBSCRIPTION_IS_LIFETIME`) and changes
 * nothing for a renewal paid anyway, so the list must never offer one:
 *
 *  - a panel with the rule marks it not renewable and says why; the list shows
 *    the VPN panel's date for it, so only the panel's word tells;
 *  - a panel older than the rule still prices it as renewable, and then its own
 *    missing date is what keeps it out — the cabinet ships first;
 *  - beside a subscription with a date, only that one is offered;
 *  - a refusal that arrives anyway (a list read before the date was taken away)
 *    says why and returns to the list, not to a review that re-prices into the
 *    same refusal — from the gateway checkout and from the partner balance.
 *
 * Mounted the way the app mounts the wizard; the step animation is off.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createRenewalCheckout: vi.fn(),
  getRenewalOptions: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getEnabledGateways: vi.fn(),
  getPaymentMethods: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
  getAddOnEntitlements: vi.fn(),
  getPlans: vi.fn(),
  activatePromocode: vi.fn(),
  getPartnerInfo: vi.fn(),
  payWithPartnerBalance: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
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
vi.mock("@/components/subscription/subscription-select-card", () => ({
  SubscriptionSelectCard: ({ subscription, onSelect }: { subscription: { id: string }; onSelect: () => void }) => (
    <button type="button" data-offered={subscription.id} onClick={onSelect}>
      {subscription.id}
    </button>
  ),
}));

import RenewalPage from "../src/features/renewal/renewal-page";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { useRenewalStore } from "../src/stores/renewal.store";

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };
const DATE = "2030-01-01T00:00:00.000Z";

/** The subscription with no end date, and one with a date. */
const LIFETIME = "sub-lifetime";
const DATED = "sub-dated";

function priced(subscriptionId: string) {
  return {
    subscriptionId,
    planId: "plan-p",
    planName: "Plan P",
    durationDays: 30,
    availableDurations: [{ id: "d-30", days: 30 }],
    currency: "RUB",
    amount: "200",
    discountPercent: 0,
    renewable: true,
    requiresPlanSelection: false,
    warnings: [],
  };
}

/** A panel with the rule, for the subscription with no end date. */
function refusedAsLifetime(subscriptionId: string) {
  return {
    subscriptionId,
    planId: null,
    planName: null,
    durationDays: null,
    availableDurations: [],
    currency: null,
    amount: null,
    discountPercent: 0,
    renewable: false,
    requiresPlanSelection: false,
    warnings: [
      { code: "SUBSCRIPTION_IS_LIFETIME", message: "The subscription has no end date: there is nothing to renew." },
      { code: "PLAN_SELECTION_REQUIRED", message: "Select a plan before requesting a quote." },
    ],
  };
}

function subscription(id: string, expiresAt: string | null, isTrial = false) {
  return { id, status: "ACTIVE", isTrial, expiresAt, plan: { name: "Plan P" } };
}

function lifetimeRefusal() {
  return Object.assign(new Error("Request failed with status code 400"), {
    isAxiosError: true,
    response: {
      status: 400,
      data: { code: "SUBSCRIPTION_IS_LIFETIME", message: "The subscription has no end date and is never renewed." },
    },
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function settleLong(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await settle();
}

function text(): string {
  return container?.textContent ?? "";
}

/** The subscriptions the list offers to renew. */
function offered(): string[] {
  return [...(container?.querySelectorAll("[data-offered]") ?? [])].map(
    (node) => node.getAttribute("data-offered") ?? "",
  );
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <RenewalPage />
      </QueryClientProvider>,
    );
  });
  await settleLong();
}

function answer(items: ReadonlyArray<ReturnType<typeof priced> | ReturnType<typeof refusedAsLifetime>>, subscriptions: unknown[]) {
  api.getRenewalOptions.mockResolvedValue({ userId: "user-1", items, currency: "RUB", total: "200" });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions });
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
  api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getPlans.mockResolvedValue([]);
  api.getPartnerInfo.mockResolvedValue(null);
  api.createRenewalCheckout.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useRenewalStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("«Продление» and a subscription with no end date", () => {
  it("says it plainly when the panel marks it — the list shows the VPN panel's date for it", async () => {
    answer([refusedAsLifetime(LIFETIME)], [subscription(LIFETIME, DATE)]);

    await mount();

    expect(offered()).toEqual([]);
    expect(text()).toContain("renewal.noneRenewable");
    expect(text()).toContain("renewal.reason.lifetime");
    expect(useRenewalStore.getState().step).toBe("subscriptions");
  });

  it("keeps it out by its own missing date when an older panel still prices it as renewable", async () => {
    answer([priced(LIFETIME)], [subscription(LIFETIME, null)]);

    await mount();

    expect(offered()).toEqual([]);
    expect(text()).toContain("renewal.reason.lifetime");
    expect(useRenewalStore.getState().selectedSubscriptionIds, "it was selected for the subscriber").toEqual([]);
    expect(useRenewalStore.getState().step).toBe("subscriptions");
  });

  it("offers only the subscription with a date beside it, from an older panel too", async () => {
    answer([priced(LIFETIME), priced(DATED)], [subscription(LIFETIME, null), subscription(DATED, DATE)]);

    await mount();

    // The one renewable subscription is selected for the subscriber, and its
    // single term takes the wizard on: never the one with no end date.
    expect(useRenewalStore.getState().selectedSubscriptionIds).toEqual([DATED]);
    expect(useRenewalStore.getState().step).not.toBe("subscriptions");
  });

  it("control: a subscription with a date alone is offered as before", async () => {
    answer([priced(DATED)], [subscription(DATED, DATE)]);

    await mount();

    expect(useRenewalStore.getState().selectedSubscriptionIds).toEqual([DATED]);
    expect(text()).not.toContain("renewal.reason.lifetime");
  });

  it("goes to «Улучшение» for a trial beside it without drawing «Продление» first, from an older panel too", async () => {
    // Nothing here is renewable: a trial is upgraded, and the other has no end
    // date. The page decides that before it draws any renewal chrome.
    answer(
      [priced(LIFETIME), { ...refusedAsLifetime("sub-trial"), warnings: [{ code: "TRIAL_NOT_RENEWABLE", message: "trial" }] }],
      [subscription(LIFETIME, null), subscription("sub-trial", DATE, true)],
    );

    await mount();

    expect(navigate).toHaveBeenCalledWith("/upgrade", { replace: true });
    expect(text(), "«Продление» was drawn before the hand-off to «Улучшение»").not.toContain("renewal.title");
  });
});

describe("a renewal refused because a subscription in it has no end date", () => {
  it("from the gateway checkout: says why and returns to the list, not to the review", async () => {
    answer([refusedAsLifetime(LIFETIME)], [subscription(LIFETIME, DATE)]);
    api.createRenewalCheckout.mockRejectedValue(lifetimeRefusal());
    useRenewalStore.setState({
      step: "checkout",
      navDirection: "forward",
      selectedSubscriptionIds: [LIFETIME],
      selectedGateway: GATEWAY,
      reviewQuote: { amount: "200", currency: "RUB" },
    });

    await mount();

    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("renewal.reason.lifetime");
    expect(toast.error).not.toHaveBeenCalledWith("renewal.checkoutError");
    expect(useRenewalStore.getState().step).toBe("subscriptions");
    expect(useRenewalStore.getState().selectedSubscriptionIds).toEqual([]);
  });

  it("control: any other refusal of the checkout still goes back to the review", async () => {
    answer([priced(DATED)], [subscription(DATED, DATE)]);
    api.createRenewalCheckout.mockRejectedValue(
      Object.assign(new Error("boom"), { response: { status: 500, data: { message: "x" } } }),
    );
    useRenewalStore.setState({
      step: "checkout",
      navDirection: "forward",
      selectedSubscriptionIds: [DATED],
      selectedGateway: GATEWAY,
      reviewQuote: { amount: "200", currency: "RUB" },
    });

    await mount();

    expect(toast.error).toHaveBeenCalledWith("renewal.checkoutError");
    expect(useRenewalStore.getState().step).toBe("review");
  });

  it("from the partner balance: says why and returns to the list", async () => {
    // The review was priced before the date was taken away; the panel refuses
    // the payment, and from then on lists the subscription as not renewable.
    let dateTaken = false;
    api.getRenewalOptions.mockImplementation(async () => ({
      userId: "user-1",
      items: [dateTaken ? refusedAsLifetime(LIFETIME) : priced(LIFETIME)],
      currency: "RUB",
      total: "200",
    }));
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription(LIFETIME, DATE)] });
    api.getPartnerInfo.mockResolvedValue({
      id: "partner-1",
      isActive: true,
      balance: 50_000,
      totalEarned: 50_000,
      totalWithdrawn: 0,
      programAvailable: true,
      balancePaymentEnabled: true,
      balanceCurrency: "RUB",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    api.payWithPartnerBalance.mockImplementation(async () => {
      dateTaken = true;
      throw lifetimeRefusal();
    });
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: [LIFETIME],
      selectedGateway: GATEWAY,
    });

    await mount();
    const balance = [...(container?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent?.trim() === "renewal.payWithBalance",
    );
    if (balance === undefined) throw new Error(`no balance payment on screen; it shows: ${text()}`);
    act(() => balance.click());
    await settleLong();

    expect(api.payWithPartnerBalance).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("renewal.reason.lifetime");
    expect(toast.error).not.toHaveBeenCalledWith("renewal.balanceError");
    expect(useRenewalStore.getState().step).toBe("subscriptions");
    // The list is read again, and now says why nothing is offered.
    expect(offered()).toEqual([]);
    expect(text()).toContain("renewal.reason.lifetime");
  });
});

describe("the words", () => {
  it("say plainly that there is nothing to renew, in both languages", () => {
    expect(ru.renewal.reason.lifetime).toBe("Подписка бессрочная — продлевать не нужно.");
    expect(en.renewal.reason.lifetime).toBe("This subscription never expires — there is nothing to renew.");
  });
});
