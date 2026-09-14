// @vitest-environment jsdom

/**
 * A catalogue that could not be loaded is not an empty catalogue.
 *
 * The service worker no longer keeps `/api/v1/plans` (it is resolved per
 * signed-in subscriber, and the worker's cache is shared by whoever signs in
 * next), so offline or on a failing panel the read simply fails. The page read
 * a failed query as `[]` and told the subscriber the operator offers no plans
 * at all — with nothing to press but Back.
 */

import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPlans: vi.fn(),
  getActionPolicy: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: ComponentProps<"button">) => <button {...props}>{children}</button>,
  },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/stores/purchase.store", () => ({ usePurchaseStore: () => ({ selectPlan: vi.fn() }) }));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button">back</button>,
}));
vi.mock("../src/features/plans/tariff-card", () => ({
  TariffCard: ({ plan }: { plan: { name: string } }) => <div data-testid="plan-card">{plan.name}</div>,
}));

import PlansPage from "../src/features/plans/plans-page";

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

async function render(): Promise<void> {
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
  await settle();
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  api.getActionPolicy.mockResolvedValue({ activeSubscriptionCount: 0, maxSubscriptions: 2 });
});

afterEach(() => {
  notifyManager.setScheduler(defaultScheduler);
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("plans page when the catalogue cannot be read", () => {
  it("says the plans could not be loaded and offers a retry, not an empty catalogue", async () => {
    api.getPlans.mockRejectedValueOnce(new Error("Network Error"));

    await render();

    expect(text(), "a failed read was presented as an operator with no plans").not.toContain(
      "plans.emptyAvailable",
    );
    expect(text()).toContain("plans.empty");

    api.getPlans.mockResolvedValueOnce([{ id: "p1", name: "Basic", isTrial: false, trialFree: false }]);
    const retry = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "common.retry",
    );
    expect(retry, "no way to try again").toBeDefined();
    act(() => retry?.click());
    await settle();
    await settle();

    expect(container?.querySelectorAll('[data-testid="plan-card"]').length).toBe(1);
    expect(text()).not.toContain("plans.empty");
  });

  it("still says so when the operator really offers no plans", async () => {
    api.getPlans.mockResolvedValueOnce([]);

    await render();

    expect(text()).toContain("plans.emptyAvailable");
    expect(text()).not.toContain("common.retry");
  });
});
