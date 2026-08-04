// @vitest-environment jsdom

/**
 * `main.tsx` wraps the whole tree in `<StrictMode>`, which runs an effect's
 * setup -> cleanup -> setup with no re-render in between. React Query
 * publishes mutation state through a `setTimeout`, so the second setup still
 * saw `isPending: false` and the auto-start guard fired a second checkout
 * draft — running `savePendingCheckout`, `startCheckoutRedirect` and
 * `navigate` twice.
 *
 * The pages are mounted here exactly as the app mounts them (inside
 * `StrictMode`, at the `checkout` step), because the previous guard read
 * correct-looking flags in isolation and only failed at the real call site.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, act, type ReactNode } from "react";
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

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  },
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false }),
  useRenewalAddOnsEnabled: () => false,
}));

import PurchasePage from "../src/features/purchase/purchase-page";
import UpgradePage from "../src/features/upgrade/upgrade-page";
import RenewalPage from "../src/features/renewal/renewal-page";
import { usePurchaseStore } from "../src/stores/purchase.store";
import { useUpgradeStore } from "../src/stores/upgrade.store";
import { useRenewalStore } from "../src/stores/renewal.store";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function mountInStrictMode(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root?.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
      </StrictMode>,
    );
  });
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  // `checkoutUrl: null` keeps `startCheckoutRedirect` out of the assertion —
  // the draft call itself is what must not double.
  api.createCheckout.mockResolvedValue({ paymentId: "pay-purchase", checkoutUrl: null });
  api.createUpgradeCheckout.mockResolvedValue({ paymentId: "pay-upgrade", checkoutUrl: null });
  api.createRenewalCheckout.mockResolvedValue({ paymentId: "pay-renewal", checkoutUrl: null });
  api.getActionPolicy.mockResolvedValue({
    canBuy: true,
    canRenew: true,
    canUpgrade: true,
    canTrial: false,
    activeSubscriptionCount: 0,
  });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
  api.getUpgradeOptions.mockResolvedValue({ plans: [] });
  // Nothing renewable + no trial: the entry decision settles without bouncing
  // to /upgrade, and the review step lands on its price-error branch, so a
  // retry can be driven without standing up the whole pricing fixture.
  api.getRenewalOptions.mockResolvedValue({ items: [], total: null, currency: null });
  api.getPartnerInfo.mockResolvedValue(null);
  api.getEnabledGateways.mockResolvedValue({ gateways: [] });
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

describe("checkout draft auto-start under StrictMode", () => {
  it("creates exactly one purchase draft", async () => {
    usePurchaseStore.setState({
      step: "checkout",
      selectedPlan: { id: "plan-1", name: "Plan", type: "BOTH" } as never,
      selectedDuration: { days: 30 } as never,
      selectedGateway: { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" },
      selectedDevice: null,
      selectedSavedPaymentMethodId: null,
      savePaymentMethodConsent: false,
    });

    await mountInStrictMode(<PurchasePage />);

    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("creates exactly one upgrade draft", async () => {
    await enterUpgradeCheckout();

    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("keeps one upgrade draft when the step advances checkout -> polling", async () => {
    // `setCheckoutResult` flips the step to `polling` while the same child is
    // still rendered. Keying that pair together on the transition keeps the
    // component mounted; a changing key would remount it with a fresh latch.
    await enterUpgradeCheckout();
    await settle();

    expect(useUpgradeStore.getState().step).toBe("polling");
    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
  });

  it("creates exactly one renewal draft", async () => {
    await enterRenewalCheckout();

    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("keeps one renewal draft when the step advances checkout -> polling", async () => {
    // Worse here than on upgrade: renewal mints `attemptId` per mount, so a
    // remount would send the second draft under a *different* idempotency key
    // — the backend would not collapse it either.
    await enterRenewalCheckout();
    await settle();

    expect(useRenewalStore.getState().step).toBe("polling");
    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(1);
  });

  it("mints a fresh renewal idempotency key when the user retries after a failure", async () => {
    // The latch must not outlive the attempt. `onError` returns to `review`,
    // unmounting `CheckoutStep`; pressing pay again has to reach the backend
    // under a NEW key, or a genuine failure would strand the user on a draft
    // the gateway already refused.
    api.createRenewalCheckout.mockRejectedValueOnce(new Error("GATEWAY_DOWN"));

    await enterRenewalCheckout();
    await settle();
    expect(useRenewalStore.getState().step).toBe("review");

    act(() => useRenewalStore.getState().setStep("checkout"));
    await settle();

    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(2);
    const [firstKey, secondKey] = api.createRenewalCheckout.mock.calls.map((call) => call[6]);
    expect(firstKey).toBeTypeOf("string");
    expect(secondKey).not.toBe(firstKey);
  });
});

/**
 * Drives the upgrade wizard the way the app does — the page stays mounted and
 * the store advances into `checkout`. Setting the step before mounting would
 * not reproduce it: `UpgradePage` resets the store from an unmount cleanup,
 * which StrictMode fires during the very first commit.
 */
async function enterUpgradeCheckout(): Promise<void> {
  await mountInStrictMode(<UpgradePage />);
  act(() => {
    useUpgradeStore.setState({
      step: "checkout",
      selectedSubscriptionId: "sub-1",
      selectedPlan: { id: "plan-2", name: "Bigger" } as never,
      selectedDurationDays: 30,
      selectedGateway: { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" },
    });
  });
  await settle();
}

/** Same shape for renewal — mount first, then advance the store into `checkout`. */
async function enterRenewalCheckout(): Promise<void> {
  await mountInStrictMode(<RenewalPage />);
  act(() => {
    useRenewalStore.setState({
      step: "checkout",
      selectedSubscriptionIds: ["sub-1"],
      selectedGateway: { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" },
      reviewQuote: { amount: "100.00", currency: "RUB" },
    });
  });
  await settle();
}
