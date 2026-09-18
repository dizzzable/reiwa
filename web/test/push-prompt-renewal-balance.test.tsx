// @vitest-environment jsdom

/**
 * A renewal paid from the partner balance makes the dashboard eligible for the
 * push prompt. It completes in place and goes straight to `/dashboard`: no
 * `/payment-return` and no provisioning handoff, so without this line it would
 * be the one purchase the prompt never follows. A failed balance payment
 * offers nothing.
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
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
  useRenewalAddOnsEnabled: () => false,
}));

import RenewalPage from "../src/features/renewal/renewal-page";
import { useRenewalStore } from "../src/stores/renewal.store";
import {
  isPushPromptEligible,
  resetPushPromptMemoryForTests,
} from "../src/features/push-prompt/push-prompt-storage";

const PAY_WITH_BALANCE = "renewal.payWithBalance";
const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };

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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function text(): string {
  return container?.textContent ?? "";
}

function button(label: string): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent?.trim() === label);
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const until = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() > until) throw new Error(`gave up waiting for ${what}; the screen shows: ${text()}`);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

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
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <RenewalPage />
      </QueryClientProvider>,
    );
  });
  await waitUntil(() => button(PAY_WITH_BALANCE) !== undefined, "the balance button");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetPushPromptMemoryForTests();
  api.getRenewalOptions.mockResolvedValue(PRICED);
  api.getAllSubscriptions.mockResolvedValue({
    subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "Plan P" } }],
  });
  api.getEnabledGateways.mockResolvedValue([{ type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true }]);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getPlans.mockResolvedValue([]);
  api.getPartnerInfo.mockResolvedValue(PARTNER);
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

describe("a renewal paid from the partner balance and the push prompt", () => {
  it("makes the dashboard it goes to eligible", async () => {
    api.payWithPartnerBalance.mockResolvedValue({ paymentId: "balance-1", transactionStatus: "COMPLETED" });
    await mountReview();
    expect(isPushPromptEligible()).toBe(false);

    act(() => button(PAY_WITH_BALANCE)!.click());
    await waitUntil(() => navigate.mock.calls.length > 0, "the way to the dashboard");

    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
    expect(isPushPromptEligible(), "a paid renewal offered nothing").toBe(true);
  }, 10_000);

  it("offers nothing when the balance payment fails", async () => {
    api.payWithPartnerBalance.mockRejectedValue(new Error("PARTNER_BALANCE_INSUFFICIENT"));
    await mountReview();

    act(() => button(PAY_WITH_BALANCE)!.click());
    await waitUntil(() => toast.error.mock.calls.length > 0, "the refusal");

    expect(isPushPromptEligible()).toBe(false);
  }, 10_000);
});
