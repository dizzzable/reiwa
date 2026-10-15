// @vitest-environment jsdom
/**
 * «Сменить тариф» is paid every way a purchase is (the owner, 15.10.2026): the
 * payment step offered the ordinary payment alone, so a customer changing plan
 * could not keep — or start — «для автоматического списания», nor charge a
 * saved card. These are the three paths through the real page: a provider's
 * autopay, a saved ЮKassa card, and the panel refusing the autopay.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpgradePlanOption } from "../src/lib/api-client/subscription";
import type { Plan } from "../src/types/api";

const api = vi.hoisted(() => ({
  createUpgradeCheckout: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getEnabledGateways: vi.fn(),
  getPaymentMethods: vi.fn(),
  getPlans: vi.fn(),
  getQuote: vi.fn(),
  getUpgradeOptions: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: { div: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
  useRenewalAddOnsEnabled: () => false,
}));

import UpgradePage from "../src/features/upgrade/upgrade-page";
import { useUpgradeStore } from "../src/stores/upgrade.store";

const target: Plan = {
  id: "plan-family",
  name: "MiniFamily",
  description: null,
  tag: null,
  icon: null,
  type: "BOTH",
  availability: "ALL",
  trafficLimit: 350,
  deviceLimit: 3,
  trafficLimitStrategy: "NO_RESET",
  orderIndex: 0,
  durations: [
    {
      id: "plan-family-d30",
      days: 30,
      prices: [
        { gatewayType: "PLATEGA", currency: "RUB", price: "299" },
        { gatewayType: "YOOKASSA", currency: "RUB", price: "299" },
      ],
    },
  ],
};
const targetOption: UpgradePlanOption = {
  id: "plan-family",
  name: "MiniFamily",
  tag: null,
  type: "BOTH",
  trafficLimit: 350,
  deviceLimit: 3,
  durations: [{ id: "plan-family-d30", days: 30 }],
};

describe("the payment step of «Сменить тариф»", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    notifyManager.setScheduler(queueMicrotask);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.getPlans.mockResolvedValue([target]);
    api.getEnabledGateways.mockResolvedValue([
      { type: "PLATEGA", displayName: "Platega", currency: "RUB", isActive: true, autopay: true },
      { type: "YOOKASSA", displayName: "ЮKassa", currency: "RUB", isActive: true, autopay: false },
    ]);
    api.getPaymentMethods.mockResolvedValue({
      methods: [{ id: "pm-1", gatewayType: "YOOKASSA", autopayEnabled: true, title: "Visa •• 4242", methodType: "bank_card" }],
    });
    api.getQuote.mockResolvedValue({
      planName: "MiniFamily",
      durationDays: 30,
      currency: "RUB",
      finalPrice: 299,
    });
    api.createUpgradeCheckout.mockResolvedValue({ paymentId: "payment-1", checkoutUrl: null });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useUpgradeStore.getState().reset();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 6; pass += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function openGatewayStep(): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <UpgradePage />
        </QueryClientProvider>,
      );
    });
    // Mount first, then advance: the page resets the store when it unmounts.
    act(() => {
      useUpgradeStore.setState({
        step: "gateway",
        selectedSubscriptionId: "sub-1",
        selectedPlan: targetOption,
        selectedDurationDays: 30,
      });
    });
    await settle();
  }

  const buttons = (): HTMLButtonElement[] => [...(container?.querySelectorAll("button") ?? [])];
  const press = async (match: (button: HTMLButtonElement) => boolean): Promise<void> => {
    const button = buttons().find(match);
    expect(button).toBeDefined();
    act(() => button?.click());
    await settle();
  };
  const autopayOption = (button: HTMLButtonElement) =>
    button.textContent?.includes("purchase.gateway.autopayCaption") === true;

  it("offers «для автоматического списания» and makes the change with it", async () => {
    await openGatewayStep();
    expect(buttons().filter(autopayOption)).toHaveLength(1);

    await press(autopayOption);
    expect(useUpgradeStore.getState()).toMatchObject({ step: "review", savePaymentMethodConsent: true });
    // The review says what the customer agrees to.
    expect(container?.textContent).toContain("purchase.quote.autopayTitle");

    await press((button) => button.textContent === "upgrade.pay");
    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    // The consent is what tells the panel to make a provider subscription;
    // nothing is asked of ЮKassa.
    expect(api.createUpgradeCheckout).toHaveBeenCalledWith(
      "plan-family",
      30,
      "PLATEGA",
      "sub-1",
      null,
      undefined,
      true,
    );
  });

  it("charges a saved ЮKassa card, and asks for no new consent", async () => {
    await openGatewayStep();

    await press((button) => button.textContent?.includes("4242") === true);
    expect(useUpgradeStore.getState()).toMatchObject({ step: "review", selectedSavedPaymentMethodId: "pm-1" });
    expect(container?.textContent).not.toContain("purchase.quote.autopayTitle");

    await press((button) => button.textContent === "upgrade.pay");
    expect(api.createUpgradeCheckout).toHaveBeenCalledWith(
      "plan-family",
      30,
      "YOOKASSA",
      "sub-1",
      "pm-1",
      undefined,
      undefined,
    );
  });

  it("says so and goes back to the review when the panel refuses the autopay", async () => {
    // A panel older than the change refuses a paid plan's change this way.
    api.createUpgradeCheckout.mockRejectedValue({
      response: { data: { code: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", reason: "PURCHASE_TYPE" } },
    });
    await openGatewayStep();
    await press(autopayOption);

    await press((button) => button.textContent === "upgrade.pay");

    expect(toast.error).toHaveBeenCalledWith("purchase.checkout.autopayNotAvailable");
    expect(useUpgradeStore.getState().step).toBe("review");
  });

  it("offers no provider's autopay for a term the provider cannot repeat", async () => {
    api.getPlans.mockResolvedValue([
      {
        ...target,
        durations: [
          { ...target.durations[0]!, prices: [{ gatewayType: "PLATEGA", currency: "RUB", price: "299.50" }] },
        ],
      },
    ]);
    await openGatewayStep();

    // Kopecks: Platega charges whole roubles, so only the ordinary payment.
    expect(buttons().filter(autopayOption)).toHaveLength(0);
    expect(buttons().some((button) => button.textContent?.includes("Platega") === true)).toBe(true);
  });
});
