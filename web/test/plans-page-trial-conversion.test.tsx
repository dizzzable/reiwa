// @vitest-environment jsdom

/**
 * «Тарифы» for a subscriber holding a trial.
 *
 * The plan picked here converts the trial (`lib/trial-conversion`): the
 * purchase is the trial's upgrade, so the list is what the trial can become,
 * the page says so before the choice, and a full account is not refused —
 * converting takes no slot. Without multi-subscription every trial holder is
 * "full", and the page used to answer their tap with «лимит подписок».
 */

import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPlans: vi.fn(),
  getActionPolicy: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getUpgradeOptions: vi.fn(),
}));

const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn(), error: vi.fn() }));
const selectPlan = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: ComponentProps<"button">) => (
      <button {...props}>{children}</button>
    ),
  },
}));
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/stores/purchase.store", () => ({ usePurchaseStore: () => ({ selectPlan }) }));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button">back</button>,
}));
vi.mock("../src/features/plans/tariff-card", () => ({
  TariffCard: ({ plan, onClick }: { plan: { id: string; name: string }; onClick: () => void }) => (
    <button type="button" data-testid={`plan-${plan.id}`} onClick={onClick}>
      {plan.name}
    </button>
  ),
}));

import PlansPage from "../src/features/plans/plans-page";

const PLANS = [
  { id: "p1", name: "Basic", isTrial: false, trialFree: false },
  { id: "p2", name: "Pro", isTrial: false, trialFree: false },
];
const TRIAL = { id: "trial-1", isTrial: true, status: "ACTIVE", userRemnaId: null };
const AT_THE_LIMIT = { limitReached: true, activeSubscriptionCount: 1, maxSubscriptions: 1 };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function card(id: string): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>(`[data-testid='plan-${id}']`) ?? null;
}

function render(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <PlansPage />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  api.getPlans.mockResolvedValue(PLANS);
  api.getActionPolicy.mockResolvedValue(AT_THE_LIMIT);
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [TRIAL] });
  // The operator let the trial become Pro only.
  api.getUpgradeOptions.mockResolvedValue({ subscriptionId: "trial-1", plans: [{ id: "p2" }], warnings: [] });
});

afterEach(() => {
  notifyManager.setScheduler(defaultScheduler);
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PlansPage beside a trial", () => {
  it("says the chosen plan replaces the trial, and not that the account is full", async () => {
    render();
    await settle();

    expect(text()).toContain("plans.trialConversion");
    expect(text()).not.toContain("subscription.limitReached");
    expect(container?.querySelector("[role='status']")).toBeNull();
  });

  it("lists what the trial can become", async () => {
    render();
    await settle();

    expect(api.getUpgradeOptions).toHaveBeenCalledWith("trial-1");
    expect(card("p2")).not.toBeNull();
    expect(card("p1"), "a plan the trial cannot become would be refused at the price").toBeNull();
  });

  it("goes on to the purchase from a full account, silently", async () => {
    render();
    await settle();

    await act(async () => {
      card("p2")?.click();
    });

    expect(toast.warning).not.toHaveBeenCalled();
    expect(selectPlan).toHaveBeenCalledWith(PLANS[1]);
    expect(navigate).toHaveBeenCalledWith("/purchase");
  });

  it("offers a retry, not an empty list, when the trial's targets cannot be read", async () => {
    api.getUpgradeOptions.mockRejectedValue(new Error("network"));
    render();
    await settle();

    expect(text()).toContain("plans.empty");
    expect(text()).toContain("common.retry");
    expect(text()).not.toContain("plans.emptyAvailable");
  });

  it("changes nothing for a subscriber without a trial", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.getActionPolicy.mockResolvedValue({ limitReached: false, activeSubscriptionCount: 0, maxSubscriptions: 2 });
    render();
    await settle();

    expect(text()).not.toContain("plans.trialConversion");
    expect(api.getUpgradeOptions).not.toHaveBeenCalled();
    expect(card("p1")).not.toBeNull();
    expect(card("p2")).not.toBeNull();
  });
});
