// @vitest-environment jsdom

/**
 * One renewal, one payment.
 *
 * A partner whose balance covers the renewal gets two ways to pay on the
 * review: «Перейти к оплате» (`renewal.pay`), whose checkout step creates a
 * gateway checkout the moment it mounts, and «Оплатить балансом (…)»
 * (`renewal.payWithBalance`), paid in place with the review still on screen.
 * Only the balance button knew its payment was out. Pay stayed live beside its
 * spinner, and again once the balance payment had gone through, so one renewal
 * could be paid from the balance and through the gateway as well.
 *
 * The other way round goes through the step animation: the wizard swaps steps
 * under `AnimatePresence mode="wait"`, so a review leaving for checkout stays
 * mounted for its 200 ms exit, and the balance button in it still took a tap.
 * So this file does NOT mock `motion/react`.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
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
  // `i18n` as the real hook returns it: a refused balance payment reads the
  // language to word a hold on the balance (`balanceHoldRefusalMessage`).
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
  useRenewalAddOnsEnabled: () => false,
}));

import RenewalPage from "../src/features/renewal/renewal-page";
import { useRenewalStore } from "../src/stores/renewal.store";

const PAY = "renewal.pay";
const PAY_WITH_BALANCE = "renewal.payWithBalance";

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };

/** sub-a renewed on its own plan for 200 RUB, as the panel prices it. */
const PRICED = {
  userId: "user-1",
  items: [
    {
      subscriptionId: "sub-a",
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
    },
  ],
  currency: "RUB",
  total: "200",
};

/** A partner allowed to pay with a balance (in kopecks) that covers those 200 RUB. */
const PARTNER = {
  id: "partner-1",
  isActive: true,
  balance: 50_000,
  totalEarned: 50_000,
  totalWithdrawn: 0,
  programAvailable: true,
  balancePaymentEnabled: true,
  balanceCurrency: "RUB",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const BALANCE_PAID = { paymentId: "balance-1", transactionStatus: "COMPLETED", amount: "200", currency: "RUB" };

/** Long enough for the 200 ms step exit, and for the step that follows to mount. */
const PAST_THE_STEP_ANIMATION_MS = 450;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets real time pass in short act() turns, so each turn's React work lands
 * while the step animation is still running.
 */
async function wait(ms: number): Promise<void> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
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

function text(): string {
  return container?.textContent ?? "";
}

function button(label: string): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

/**
 * Taps the on-screen button with exactly this label, as the subscriber would:
 * a button that is disabled takes no tap. One that is not on screen fails the
 * case, so a check that it did nothing cannot pass for a button that was never
 * there.
 */
async function tap(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`no "${label}" button on screen; it shows: ${text()}`);
  act(() => target.click());
  await settle();
}

/** The review for sub-a through YooKassa, with both ways to pay on screen. */
async function mountReview(): Promise<void> {
  useRenewalStore.setState({
    step: "review",
    navDirection: "forward",
    selectedSubscriptionIds: ["sub-a"],
    selectedGateway: GATEWAY,
  });
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
  await waitUntil(() => button(PAY) !== undefined && button(PAY_WITH_BALANCE) !== undefined);
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
  api.getRenewalOptions.mockResolvedValue(PRICED);
  api.getAllSubscriptions.mockResolvedValue({
    subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "Plan P" } }],
  });
  api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getPlans.mockResolvedValue([]);
  api.getPartnerInfo.mockResolvedValue(PARTNER);
  api.payWithPartnerBalance.mockResolvedValue(BALANCE_PAID);
  // The checkout never answers: whether it was created is all these cases ask,
  // and an answer would send the page off to the gateway.
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

describe("renewal review: one renewal, one payment", () => {
  it("starts no gateway checkout while the balance payment is still out", async () => {
    let answerBalance: ((result: typeof BALANCE_PAID) => void) | null = null;
    api.payWithPartnerBalance.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerBalance = resolve;
        }),
    );

    await mountReview();
    await tap(PAY_WITH_BALANCE);
    expect(answerBalance, "the balance payment never went out").not.toBeNull();

    // It seems slow, so the subscriber taps the other way to pay.
    await tap(PAY);
    await wait(PAST_THE_STEP_ANIMATION_MS);

    expect(
      api.createRenewalCheckout,
      "a gateway checkout was created for the renewal the balance was paying for",
    ).not.toHaveBeenCalled();
    expect(useRenewalStore.getState().step, "the review left for checkout with the balance payment out").toBe(
      "review",
    );
    expect(api.payWithPartnerBalance).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("offers no second payment once the balance payment went through", async () => {
    await mountReview();
    await tap(PAY_WITH_BALANCE);
    await waitUntil(() => navigate.mock.calls.length > 0);
    expect(toast.success).toHaveBeenCalledWith("renewal.balancePaid");
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });

    // `navigate` is mocked, so the review stays on screen as it does in the app
    // until the dashboard replaces it.
    await waitUntil(() => button(PAY_WITH_BALANCE) !== undefined);
    await tap(PAY_WITH_BALANCE);
    await tap(PAY);
    await wait(PAST_THE_STEP_ANIMATION_MS);

    expect(
      api.createRenewalCheckout,
      "the renewal paid from the balance was offered to the gateway as well",
    ).not.toHaveBeenCalled();
    expect(api.payWithPartnerBalance, "the renewal was paid from the balance twice").toHaveBeenCalledTimes(1);
    expect(useRenewalStore.getState().step).toBe("review");
  }, 10_000);

  it("takes no balance payment while it animates out towards the checkout", async () => {
    await mountReview();
    // Held from before the tap: the review leaving is the same element.
    const balance = button(PAY_WITH_BALANCE)!;

    await tap(PAY);
    expect(useRenewalStore.getState().step).toBe("checkout");
    expect(balance.isConnected, "the review was gone before its exit could be tapped").toBe(true);
    act(() => balance.click());
    await settle();
    await wait(PAST_THE_STEP_ANIMATION_MS);

    expect(
      api.payWithPartnerBalance,
      "the review leaving for checkout took a balance payment for the same renewal",
    ).not.toHaveBeenCalled();
    expect(api.createRenewalCheckout, "the checkout the subscriber chose did not start").toHaveBeenCalledTimes(1);
  }, 10_000);

  it("starts no checkout from a review that is no longer the step, whatever moved it", async () => {
    // Nothing on a priced review moves the wizard anywhere but checkout today,
    // so the step is moved from outside, as in renewal-review-visit's "does not
    // act on a price that lands after it stopped being the step".
    await mountReview();
    act(() => useRenewalStore.getState().goBack("gateway"));
    await settle();

    await tap(PAY);
    await wait(PAST_THE_STEP_ANIMATION_MS);

    expect(
      api.createRenewalCheckout,
      "a review animating out towards the gateway step started a checkout",
    ).not.toHaveBeenCalled();
    expect(useRenewalStore.getState().step, "a review that had left moved the wizard to checkout").toBe("gateway");
  }, 10_000);

  it("gives the gateway back when the balance payment fails", async () => {
    // Guard: the lock is for a payment under way or done, not for one that failed.
    api.payWithPartnerBalance.mockRejectedValue(new Error("PARTNER_BALANCE_INSUFFICIENT"));

    await mountReview();
    await tap(PAY_WITH_BALANCE);
    await waitUntil(() => toast.error.mock.calls.length > 0);
    expect(toast.error).toHaveBeenCalledWith("renewal.balanceError");
    expect(button(PAY)?.disabled, "a failed balance payment left Pay locked").toBe(false);

    await tap(PAY);
    await waitUntil(() => api.createRenewalCheckout.mock.calls.length > 0);

    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(1);
    expect(navigate, "a failed balance payment was taken for a paid renewal").not.toHaveBeenCalled();
  }, 10_000);
});
