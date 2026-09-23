// @vitest-environment jsdom

/**
 * «Улучшение» draws its target plans on the cards «Тарифы» and renewal draw.
 *
 * The owner, 23.09.2026: the upgrade picker showed a bare row per plan — name,
 * devices, traffic, a tick — where buying and renewing show the plan's card:
 * icon, description, «от ₽…», its terms, the look the operator gave it. An
 * upgrade option carries none of that; the catalog plan does. These cases are
 * what the card is drawn from, and what the picker does when it cannot be.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpgradePlanOption } from "../src/lib/api-client/subscription";
import type { Plan } from "../src/types/api";

const api = vi.hoisted(() => ({
  getUpgradeOptions: vi.fn(),
  getPlans: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getEnabledGateways: vi.fn(),
  getQuote: vi.fn(),
  createUpgradeCheckout: vi.fn(),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: { div: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
  useRenewalAddOnsEnabled: () => false,
}));
// The real card pulls in WebGL layers and branding. This one says what it was
// handed: the plan's description (only a catalog plan has one) and its terms.
vi.mock("../src/features/plans/tariff-card", () => ({
  TariffCard: ({ plan, onClick }: { readonly plan: Plan; readonly onClick: () => void }) => (
    <button
      type="button"
      data-tariff-card={plan.name}
      data-days={plan.durations.map((duration) => duration.days).join(",")}
      data-display-days={(plan.displayPrices ?? []).map((price) => price.days).join(",")}
      onClick={onClick}
    >
      {plan.description}
    </button>
  ),
}));

import { upgradeCardPlan } from "../src/features/upgrade/upgrade-card-plan";
import UpgradePage from "../src/features/upgrade/upgrade-page";
import { useUpgradeStore } from "../src/stores/upgrade.store";

function catalogPlan(id: string, name: string, days: readonly number[]): Plan {
  return {
    id,
    name,
    description: `${name}: подписка для тебя и друзей`,
    tag: null,
    icon: null,
    type: "BOTH",
    availability: "ALL",
    trafficLimit: 350,
    deviceLimit: 3,
    trafficLimitStrategy: "NO_RESET",
    orderIndex: 0,
    durations: days.map((d) => ({
      id: `${id}-d${d}`,
      days: d,
      prices: [{ currency: "RUB", price: d * 20 }],
    })),
    displayPrices: days.map((d) => ({ currency: "RUB", price: d * 20, days: d })),
  };
}

function option(plan: Plan, days: readonly number[], ids = true): UpgradePlanOption {
  return {
    id: String(plan.id),
    name: plan.name,
    tag: null,
    type: plan.type,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit ?? 0,
    durations: days.map((d) => ({ id: ids ? `${plan.id}-d${d}` : `other-${d}`, days: d })),
  };
}

describe("upgradeCardPlan — the catalog plan an upgrade option is drawn as", () => {
  const family = catalogPlan("plan-family", "MiniFamily", [30, 90, 365]);

  it("keeps only the terms the upgrade offers, in its gateway prices and its display prices", () => {
    const card = upgradeCardPlan(option(family, [90, 365]), family);
    expect(card?.durations.map((d) => d.days)).toEqual([90, 365]);
    expect(card?.displayPrices?.map((p) => p.days)).toEqual([90, 365]);
    // Everything the card is drawn from comes with it.
    expect(card?.description).toBe(family.description);
  });

  it("matches a term by its length when the ids do not match", () => {
    const card = upgradeCardPlan(option(family, [30], false), family);
    expect(card?.durations.map((d) => d.days)).toEqual([30]);
  });

  it("is nothing for a plan the catalog does not list, or one whose terms the upgrade does not offer", () => {
    expect(upgradeCardPlan(option(family, [90]), undefined)).toBeNull();
    expect(upgradeCardPlan(option(family, [7], false), family)).toBeNull();
  });
});

describe("the upgrade's plan step", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let queryClient: QueryClient;

  const family = catalogPlan("plan-family", "MiniFamily", [30, 90]);
  // A target the public catalog does not list.
  const unlisted = catalogPlan("plan-unlisted", "Unlisted", [30]);

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    notifyManager.setScheduler(queueMicrotask);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.getEnabledGateways.mockResolvedValue([]);
    api.getPlans.mockResolvedValue([family]);
    api.getUpgradeOptions.mockResolvedValue({
      subscriptionId: "sub-1",
      plans: [option(family, [90]), option(unlisted, [30])],
      warnings: [],
    });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useUpgradeStore.getState().reset();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function openPlanStep(): Promise<void> {
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
      useUpgradeStore.setState({ step: "plan", selectedSubscriptionId: "sub-1" });
    });
    for (let pass = 0; pass < 6; pass += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("draws a catalog plan on its tariff card, with the upgrade's terms", async () => {
    await openPlanStep();
    const card = container?.querySelector<HTMLElement>('[data-tariff-card="MiniFamily"]');
    expect(card?.textContent).toBe(family.description);
    expect(card?.dataset.days).toBe("90");
    expect(card?.dataset.displayDays).toBe("90");
  });

  it("keeps the plain row for a plan the catalog does not list — it is not left out", async () => {
    await openPlanStep();
    expect(container?.querySelector('[data-tariff-card="Unlisted"]')).toBeNull();
    expect(container?.textContent).toContain("Unlisted");
  });

  it("chooses the upgrade option, not the catalog plan, when its card is tapped", async () => {
    await openPlanStep();
    act(() => {
      container?.querySelector<HTMLElement>('[data-tariff-card="MiniFamily"]')?.click();
    });
    expect(useUpgradeStore.getState().selectedPlan).toEqual(option(family, [90]));
  });
});
