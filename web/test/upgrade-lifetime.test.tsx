// @vitest-environment jsdom

/**
 * «Улучшение» and a subscription with no end date (the owner, 24.09.2026).
 *
 * A purchase does not change such a subscription's plan: an upgrade restarts
 * the term at the payment, which would give it an end date. The panel refuses
 * the quote and the checkout (`SUBSCRIPTION_IS_LIFETIME`); here the page must
 * not offer it and must say why — at every step it can meet one: the list of
 * subscriptions (by the row's own date), the plan step and the review (by the
 * panel's word, for a row the list shows with the VPN panel's date), and the
 * checkout's refusal. A trial is still upgraded: that is how a trial is left.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Subscription } from "../src/types/api";

const api = vi.hoisted(() => ({
  getUpgradeOptions: vi.fn(),
  getPlans: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getEnabledGateways: vi.fn(),
  getQuote: vi.fn(),
  createUpgradeCheckout: vi.fn(),
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
// The real tile draws the dashboard card; this one says which subscription it is.
vi.mock("@/components/subscription/subscription-select-card", () => ({
  SubscriptionSelectCard: ({ subscription, onSelect }: { readonly subscription: Subscription; readonly onSelect: () => void }) => (
    <button type="button" data-subscription={subscription.id} onClick={onSelect} />
  ),
}));

import UpgradePage from "../src/features/upgrade/upgrade-page";
import { useUpgradeStore } from "../src/stores/upgrade.store";

function subscription(id: string, input: { readonly expiresAt: string | null; readonly isTrial?: boolean }): Subscription {
  return {
    id,
    status: "ACTIVE",
    isTrial: input.isTrial ?? false,
    userRemnaId: null,
    trafficLimit: null,
    deviceLimit: null,
    expiresAt: input.expiresAt,
    url: null,
    plan: { id: "plan-1", name: "Plan", type: "BOTH" },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const DATED = "2027-01-01T00:00:00.000Z";
const LIFETIME_WARNING = { code: "SUBSCRIPTION_IS_LIFETIME", message: "no end date" };
const TARGET = { id: "plan-2", name: "Bigger", tag: null, type: "BOTH", trafficLimit: null, deviceLimit: 5, durations: [{ id: "d30", days: 30 }] };

describe("«Улучшение» and a subscription with no end date", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    notifyManager.setScheduler(queueMicrotask);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.getEnabledGateways.mockResolvedValue([]);
    api.getPlans.mockResolvedValue([]);
    api.getUpgradeOptions.mockResolvedValue({ subscriptionId: "sub-1", plans: [], warnings: [] });
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

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  /** Mounts the page, then puts the store where the case starts: the page resets it when it unmounts. */
  async function open(state: Partial<ReturnType<typeof useUpgradeStore.getState>> = {}): Promise<HTMLDivElement> {
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
    act(() => {
      useUpgradeStore.setState(state);
    });
    await settle();
    return container;
  }

  const listed = (page: HTMLElement) =>
    [...page.querySelectorAll<HTMLElement>("[data-subscription]")].map((tile) => tile.dataset.subscription);

  it("leaves it out of the list and says why; a subscription with a date and a trial stay", async () => {
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [
        subscription("lifetime", { expiresAt: null }),
        subscription("dated", { expiresAt: DATED }),
        subscription("trial", { expiresAt: null, isTrial: true }),
      ],
    });

    const page = await open();

    expect(listed(page)).toEqual(["dated", "trial"]);
    expect(page.textContent).toContain("upgrade.lifetime");
  });

  it("says why, and not «nothing to upgrade», when every subscription has no end date", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("lifetime", { expiresAt: null })] });

    const page = await open();

    expect(listed(page)).toEqual([]);
    expect(page.textContent).toContain("upgrade.lifetime");
    expect(page.textContent).not.toContain("upgrade.noneUpgradeable");
  });

  it("control: with none such, the list says nothing of it", async () => {
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [subscription("dated", { expiresAt: DATED }), subscription("dated-2", { expiresAt: DATED })],
    });

    const page = await open();

    expect(listed(page)).toEqual(["dated", "dated-2"]);
    expect(page.textContent).not.toContain("upgrade.lifetime");
  });

  it("the plan step names the reason the panel closed it for — a row the list showed with a date", async () => {
    api.getUpgradeOptions.mockResolvedValue({ subscriptionId: "sub-1", plans: [], warnings: [LIFETIME_WARNING] });

    const page = await open({ step: "plan", selectedSubscriptionId: "sub-1" });

    expect(page.textContent).toContain("upgrade.lifetime");
    expect(page.textContent).not.toContain("upgrade.noTargets");
  });

  it("control: a plan step with no targets for any other reason says there are none", async () => {
    const page = await open({ step: "plan", selectedSubscriptionId: "sub-1" });

    expect(page.textContent).toContain("upgrade.noTargets");
    expect(page.textContent).not.toContain("upgrade.lifetime");
  });

  it("the review says why, and does not read the refusal as a withdrawn plan", async () => {
    api.getQuote.mockResolvedValue({ warning: "SUBSCRIPTION_IS_LIFETIME", warnings: [LIFETIME_WARNING, { code: "PLAN_NOT_AVAILABLE", message: "" }] });

    const page = await open({
      step: "review",
      selectedSubscriptionId: "sub-1",
      selectedPlan: TARGET,
      selectedDurationDays: 30,
      selectedGateway: { id: "YOOKASSA", label: "ЮKassa", icon: "💳", currency: "RUB" },
    });

    expect(page.textContent).toContain("upgrade.lifetime");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(useUpgradeStore.getState().step).toBe("review");
    expect(page.textContent).not.toContain("upgrade.pay");
  });

  it("a checkout the panel refuses for it: says why, and starts over from the list", async () => {
    api.createUpgradeCheckout.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 400"), {
        response: { status: 400, data: { code: "SUBSCRIPTION_IS_LIFETIME", message: "no end date" } },
      }),
    );

    await open({
      step: "checkout",
      selectedSubscriptionId: "sub-1",
      selectedPlan: TARGET,
      selectedDurationDays: 30,
      selectedGateway: { id: "YOOKASSA", label: "ЮKassa", icon: "💳", currency: "RUB" },
    });

    expect(api.createUpgradeCheckout).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("upgrade.lifetime");
    expect(useUpgradeStore.getState().step).toBe("subscriptions");
    expect(useUpgradeStore.getState().selectedSubscriptionId).toBeNull();
  });
});
