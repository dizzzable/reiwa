// @vitest-environment jsdom

/**
 * «для автоматического списания» is not offered on a renewal onto another plan.
 *
 * On Platega and RollyPay the provider repeats one sum for one plan, and the
 * panel refuses such a sign-up when the renewal moves the subscription to
 * another plan — an archived plan's replacement, or a plan chosen at renewal —
 * because the subscription keeps its old plan until the new plan's term begins
 * and the charges would be cancelled as "moved" (reason `PLAN_CHANGE`). A page
 * that offered it would only lead the buyer to that refusal.
 *
 * The real page from its gateway step, the api mocked at the client module.
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

const AUTOPAY_CAPTION = "purchase.gateway.autopayCaption";
const PLATEGA_WIRE = { type: "PLATEGA", displayName: "Platega", currency: "RUB", isActive: true, autopay: true };

/** sub-a, on plan-p, renewed for 30 days onto `planId`. */
function options(planId: string) {
  return {
    userId: "user-1",
    items: [
      {
        subscriptionId: "sub-a",
        planId,
        planName: planId,
        durationDays: 30,
        availableDurations: [{ id: "d-30", days: 30 }],
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

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

/** Platega's options on the gateway step, once both the ordinary one and the page's data are there. */
async function mountGatewayStep(selectedPlans: Record<string, string> = {}): Promise<void> {
  useRenewalStore.setState({
    step: "gateway",
    navDirection: "back",
    selectedSubscriptionIds: ["sub-a"],
    selectedPlans,
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
  await waitUntil(
    () =>
      text().includes("Platega") &&
      queryClient.getQueryData(["renewal-options", {}, {}]) !== undefined &&
      api.getAllSubscriptions.mock.results.length > 0,
  );
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
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
  api.getAllSubscriptions.mockResolvedValue({
    subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { id: "plan-p", name: "Plan P" } }],
  });
  api.getEnabledGateways.mockResolvedValue([PLATEGA_WIRE]);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getPlans.mockResolvedValue([]);
  api.getPartnerInfo.mockResolvedValue(null);
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

describe("renewal: «для автоматического списания» and the plan it renews onto", () => {
  it("is offered on a renewal onto the plan the subscription is on", async () => {
    api.getRenewalOptions.mockResolvedValue(options("plan-p"));

    await mountGatewayStep();

    expect(text()).toContain(AUTOPAY_CAPTION);
  });

  it("is not offered on a renewal onto an archived plan's replacement", async () => {
    api.getRenewalOptions.mockResolvedValue(options("plan-replacement"));

    await mountGatewayStep();

    expect(text()).toContain("Platega");
    expect(text()).not.toContain(AUTOPAY_CAPTION);
  });

  it("is not offered on a renewal onto a plan chosen at renewal", async () => {
    api.getRenewalOptions.mockResolvedValue(options("plan-p"));

    await mountGatewayStep({ "sub-a": "plan-other" });

    expect(text()).toContain("Platega");
    expect(text()).not.toContain(AUTOPAY_CAPTION);
  });
});
