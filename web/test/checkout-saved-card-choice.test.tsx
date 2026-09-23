// @vitest-environment jsdom

/**
 * A saved card is a choice, even when only one gateway is enabled.
 *
 * Both gateway steps auto-pick a single enabled gateway, and both render a
 * "saved cards" section above it for a YooKassa subscriber: charge a saved card,
 * or open a new payment page. The purchase step auto-picked regardless, and the
 * renewal step decided before the saved cards had loaded — so the card list,
 * the one real choice on the screen, was skipped for exactly the subscribers
 * who have a card, and they were sent to a fresh payment page.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  createRenewalCheckout: vi.fn(),
  getActionPolicy: vi.fn(),
  getQuote: vi.fn(),
  getEnabledGateways: vi.fn(),
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

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
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
  SubscriptionSelectCard: ({ subtitle }: { subtitle?: string }) => <div>{subtitle}</div>,
}));

import PurchasePage from "../src/features/purchase/purchase-page";
import RenewalPage from "../src/features/renewal/renewal-page";
import { usePurchaseStore } from "../src/stores/purchase.store";
import { useRenewalStore } from "../src/stores/renewal.store";

const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };
const SAVED_CARD = {
  id: "pm-1",
  gatewayType: "YOOKASSA",
  methodType: "bank_card",
  title: "Visa 4242",
  cardLast4: "4242",
  cardFirst6: "424242",
  cardExpiryMonth: "12",
  cardExpiryYear: "2030",
  cardIssuerCountry: null,
  cardProduct: null,
  autopayEnabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
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

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  for (let i = 0; i < 5; i += 1) await settle();
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
  });
  api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
  api.getPartnerInfo.mockResolvedValue(null);
  // The steps after the gateway are not what this spec is about.
  api.getQuote.mockReturnValue(new Promise(() => undefined));
  api.getAllSubscriptions.mockResolvedValue({
    subscriptions: [{ id: "sub-1", status: "ACTIVE", isTrial: false, plan: { name: "Plan" } }],
  });
  api.getRenewalOptions.mockImplementation(async (input?: { gatewayType?: string }) => {
    // The review read stays pending; the list read answers with one
    // subscription on a single-term plan, so the list step is skipped.
    if (input?.gatewayType !== undefined) return new Promise(() => undefined);
    return {
      userId: "user-1",
      items: [
        {
          subscriptionId: "sub-1",
          planId: "plan-1",
          planName: "Plan",
          durationDays: 30,
          availableDurations: [{ id: "d-30", days: 30 }],
          currency: "RUB",
          amount: "100",
          discountPercent: 0,
          renewable: true,
          requiresPlanSelection: false,
          warnings: [],
        },
      ],
      currency: "RUB",
      total: "100",
    };
  });
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

/** Opens the purchase wizard on its gateway step, arriving forward. */
async function openPurchaseGateway(): Promise<void> {
  usePurchaseStore.setState({
    step: "gateway",
    lastNav: "forward",
    selectedPlan: { id: "plan-1", name: "Plan", type: "BOTH", durations: [] } as never,
    selectedDuration: { id: "d-30", days: 30, prices: [] } as never,
    selectedGateway: null,
    selectedSavedPaymentMethodId: null,
  });
  await mount(<PurchasePage />);
}

describe("purchase: one enabled gateway", () => {
  it("offers a saved card instead of picking the gateway for the subscriber", async () => {
    api.getPaymentMethods.mockResolvedValue({ methods: [SAVED_CARD], total: 1 });

    await openPurchaseGateway();

    expect(usePurchaseStore.getState().step, "the saved-card choice was skipped").toBe("gateway");
    expect(usePurchaseStore.getState().selectedGateway).toBeNull();
    expect(text()).toContain("Visa 4242");
  });

  it("still picks the single gateway when there is no saved card", async () => {
    api.getPaymentMethods.mockResolvedValue({ methods: [], total: 0 });

    await openPurchaseGateway();

    expect(usePurchaseStore.getState().step).toBe("quote");
    expect(usePurchaseStore.getState().selectedGateway?.id).toBe("YOOKASSA");
  });

  it("still picks the single gateway when the saved cards cannot be read", async () => {
    api.getPaymentMethods.mockRejectedValue(new Error("Request failed with status code 500"));

    await openPurchaseGateway();

    expect(usePurchaseStore.getState().step).toBe("quote");
  });
});

describe("renewal: one enabled gateway", () => {
  it("waits for the saved cards and offers them instead of picking the gateway", async () => {
    api.getPaymentMethods.mockResolvedValue({ methods: [SAVED_CARD], total: 1 });

    await mount(<RenewalPage />);

    expect(useRenewalStore.getState().step, "the saved-card choice was skipped").toBe("gateway");
    expect(useRenewalStore.getState().selectedGateway).toBeNull();
    expect(text()).toContain("Visa 4242");
  });

  it("still picks the single gateway when there is no saved card", async () => {
    api.getPaymentMethods.mockResolvedValue({ methods: [], total: 0 });

    await mount(<RenewalPage />);

    expect(useRenewalStore.getState().step).toBe("review");
    expect(useRenewalStore.getState().selectedGateway?.id).toBe("YOOKASSA");
  });
});
