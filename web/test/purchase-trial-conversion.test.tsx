// @vitest-environment jsdom

/**
 * A purchase beside a trial converts the trial.
 *
 * With multi-subscription on, «Купить» beside a trial created a second
 * subscription (ADDITIONAL): the buyer came away holding the trial AND another
 * subscription with another link to set up. The wizard now prices and pays the
 * trial's UPGRADE — the same subscription and link, the term from payment — by
 * every way it pays, and waits for no new subscription afterwards.
 *
 * The real wizard from its quote step, the api mocked at the client module.
 * `motion/react` is not mocked: the checkout step mounts after the quote's exit,
 * as it does for the buyer.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  createUpgradeCheckout: vi.fn(),
  getActionPolicy: vi.fn(),
  getQuote: vi.fn(),
  getEnabledGateways: vi.fn(),
  getPaymentMethods: vi.fn(),
  activatePromocode: vi.fn(),
  getPartnerInfo: vi.fn(),
  payWithPartnerBalance: vi.fn(),
  getAllSubscriptions: vi.fn(),
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
}));

import PurchasePage from "../src/features/purchase/purchase-page";
import { usePurchaseStore } from "../src/stores/purchase.store";

const PAY = "purchase.quote.pay";
const PAY_WITH_BALANCE = "purchase.quote.payWithBalance";
const CONVERSION_NOTICE = "purchase.quote.trialConversion";
/** Where the wizard leaves word that a NEW subscription is on its way. */
const RECEIPTS_KEY = "reiwa:subscription-provisioning-receipts";

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };

/** Plan P for 30 days through YooKassa, 200 RUB as the panel prices it. */
const PRICED = {
  planId: "plan-p",
  planName: "Plan P",
  durationDays: 30,
  currency: "RUB",
  basePrice: 200,
  finalPrice: 200,
  discountPercent: 0,
  gatewayType: "YOOKASSA",
};

/** A partner whose balance (in kopecks) covers those 200 RUB. */
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

const POLICY = {
  canBuy: true,
  canRenew: false,
  canUpgrade: true,
  canTrial: false,
  activeSubscriptionCount: 1,
  maxSubscriptions: 3,
  limitReached: false,
};

const TRIAL = { id: "trial-1", isTrial: true, status: "ACTIVE", userRemnaId: null };
const PAID = { id: "paid-1", isTrial: false, status: "ACTIVE", userRemnaId: null };

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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

async function tap(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`no "${label}" button on screen; it shows: ${text()}`);
  act(() => target.click());
  await settle();
}

/** The quote for Plan P through YooKassa, both ways to pay on screen. */
async function mountQuote(): Promise<void> {
  usePurchaseStore.setState({
    step: "quote",
    lastNav: "forward",
    selectedPlan: { id: "plan-p", name: "Plan P", type: "BOTH", durations: [], isTrial: false } as never,
    selectedDuration: { id: "d-30", days: 30, prices: [] } as never,
    selectedGateway: GATEWAY,
    selectedDevice: null,
    selectedSavedPaymentMethodId: null,
    savePaymentMethodConsent: false,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <PurchasePage />
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
  api.getActionPolicy.mockResolvedValue(POLICY);
  api.getQuote.mockResolvedValue(PRICED);
  api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getPartnerInfo.mockResolvedValue(PARTNER);
  api.payWithPartnerBalance.mockResolvedValue({
    paymentId: "balance-1",
    transactionStatus: "COMPLETED",
    amount: "200",
    currency: "RUB",
  });
  api.createCheckout.mockResolvedValue({ paymentId: "pay-new", checkoutUrl: null });
  api.createUpgradeCheckout.mockResolvedValue({ paymentId: "pay-conversion", checkoutUrl: null });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  usePurchaseStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  api.getAllSubscriptions.mockReset();
  api.createCheckout.mockReset();
});

describe("a purchase beside a trial", () => {
  it("is priced as the trial's upgrade, and says the trial becomes the plan", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [PAID, TRIAL] });

    await mountQuote();

    expect(api.getQuote).toHaveBeenCalledWith("plan-p", 30, "YOOKASSA", "UPGRADE", "trial-1");
    expect(api.getQuote).not.toHaveBeenCalledWith("plan-p", 30, "YOOKASSA");
    expect(text()).toContain(CONVERSION_NOTICE);
  });

  it("pays through the trial's upgrade and waits for no new subscription", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [TRIAL] });

    await mountQuote();
    await tap(PAY);
    await waitUntil(() => navigate.mock.calls.length > 0);

    expect(api.createCheckout, "a second subscription was bought beside the trial").not.toHaveBeenCalled();
    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    expect(api.createUpgradeCheckout.mock.calls[0]!.slice(0, 4)).toEqual([
      "plan-p",
      30,
      "YOOKASSA",
      "trial-1",
    ]);
    expect(navigate).toHaveBeenCalledWith("/payment-return?paymentId=pay-conversion", { replace: true });
    expect(window.sessionStorage.getItem(RECEIPTS_KEY), "the dashboard would wait for a subscription that never comes").toBeNull();
  }, 10_000);

  it("pays from the partner balance as the trial's upgrade", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [TRIAL] });

    await mountQuote();
    await tap(PAY_WITH_BALANCE);
    await waitUntil(() => navigate.mock.calls.length > 0);

    expect(api.payWithPartnerBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseType: "UPGRADE",
        subscriptionId: "trial-1",
        planId: "plan-p",
        durationDays: 30,
      }),
    );
    expect(window.sessionStorage.getItem(RECEIPTS_KEY)).toBeNull();
  });

  it("does not send a trial holder at the limit away: converting takes no slot", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [TRIAL] });
    api.getActionPolicy.mockResolvedValue({
      ...POLICY,
      canBuy: false,
      activeSubscriptionCount: 1,
      maxSubscriptions: 1,
      limitReached: true,
    });

    await mountQuote();
    await settle();

    expect(navigate).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(text()).toContain(CONVERSION_NOTICE);
  });

  it("still creates a subscription where there is no trial", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [PAID] });

    await mountQuote();
    expect(api.getQuote).toHaveBeenCalledWith("plan-p", 30, "YOOKASSA");
    expect(text()).not.toContain(CONVERSION_NOTICE);

    await tap(PAY);
    await waitUntil(() => navigate.mock.calls.length > 0);

    expect(api.createUpgradeCheckout).not.toHaveBeenCalled();
    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    expect(api.createCheckout.mock.calls[0]![7]).toBe("ADDITIONAL");
    expect(window.sessionStorage.getItem(RECEIPTS_KEY)).not.toBeNull();
  }, 10_000);

  it("turns into the conversion when the panel names a trial the list did not show", async () => {
    // Read before the trial was claimed — in another tab, say.
    api.getAllSubscriptions
      .mockResolvedValueOnce({ subscriptions: [PAID] })
      .mockResolvedValue({ subscriptions: [PAID, TRIAL] });
    api.createCheckout.mockRejectedValue({
      response: { status: 400, data: { code: "TRIAL_UPGRADE_REQUIRED" } },
    });

    await mountQuote();
    await tap(PAY);
    await waitUntil(() => toast.warning.mock.calls.length > 0);

    expect(toast.warning).toHaveBeenCalledWith(
      "purchase.checkout.trialConversionRequired",
      expect.anything(),
    );
    // Back on the quote, priced again as the conversion; nothing more is paid
    // until the buyer presses Pay on it.
    await waitUntil(() => text().includes(CONVERSION_NOTICE) && button(PAY) !== undefined);
    expect(api.getQuote).toHaveBeenLastCalledWith("plan-p", 30, "YOOKASSA", "UPGRADE", "trial-1");
    expect(api.createUpgradeCheckout).not.toHaveBeenCalled();
    expect(api.createCheckout).toHaveBeenCalledTimes(1);
  }, 10_000);
});
