// @vitest-environment jsdom

/**
 * PlansPage at capacity — say it once, and keep the catalogue visible.
 *
 * Being full is a reason not to be able to BUY, not a reason to be unable to
 * LOOK. The page used to replace the whole tariff list with a full-height
 * notice AND fire `notifySubscriptionLimitReached` on mount — which is a toast,
 * a haptic buzz and a blocking Telegram dialog — so one fact arrived three
 * times while the thing the customer came to see was hidden behind it.
 *
 * These pin both halves: the list survives, and the mount is silent. The toast
 * still belongs on a REFUSED TAP, so that is asserted too — a "fix" that simply
 * deleted every notice would otherwise pass.
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
}));

const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn(), error: vi.fn() }));
const selectPlan = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Echo the key plus its interpolation so a test can tell the detailed
    // message from the generic one without depending on Russian copy.
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
// The real card drags in WebGL-ish effect layers and branding context; this
// keeps the spec about the page's decision, while staying a real button so the
// tap path below is the one production uses.
vi.mock("../src/features/plans/tariff-card", () => ({
  TariffCard: ({ plan, onClick }: { plan: { id: string; name: string }; onClick: () => void }) => (
    <button type="button" data-testid={`plan-${plan.id}`} onClick={onClick}>
      {plan.name}
    </button>
  ),
}));

import PlansPage from "../src/features/plans/plans-page";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const PLANS = [
  { id: "p1", name: "Basic", isTrial: false, trialFree: false },
  { id: "p2", name: "Pro", isTrial: false, trialFree: false },
];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
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
  // Settle races: React Query registers its notification timer after the one
  // `settle()` opened, both at 0 ms. Microtasks always drain ahead of timers,
  // so this keeps the re-render inside the open act scope under full-suite
  // load. Same reason as `devices-page-load-failure.test.tsx`.
  notifyManager.setScheduler(queueMicrotask);
  api.getPlans.mockReset();
  api.getActionPolicy.mockReset();
  navigate.mockReset();
  selectPlan.mockReset();
  toast.warning.mockReset();
  api.getPlans.mockResolvedValue(PLANS);
});

afterEach(() => {
  notifyManager.setScheduler(defaultScheduler);
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  delete (window as { Telegram?: unknown }).Telegram;
});

describe("PlansPage at capacity", () => {
  it("keeps the catalogue on screen and states the limit once", async () => {
    api.getActionPolicy.mockResolvedValue({
      limitReached: true,
      activeSubscriptionCount: 1,
      maxSubscriptions: 1,
    });
    render();
    await settle();

    // The whole point: the customer can still see what is on offer.
    expect(container?.querySelector("[data-testid='plan-p1']")).not.toBeNull();
    expect(container?.querySelector("[data-testid='plan-p2']")).not.toBeNull();

    // …with the reason they cannot buy stated in place, and stated with the
    // real numbers rather than the generic fallback.
    const notice = container?.querySelector("[role='status']");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("subscription.limitReachedDetail");
    expect(notice?.textContent).toContain('"current":1');
    expect(notice?.textContent).toContain('"max":1');

    // Exactly once. A second copy of the same sentence anywhere on the page is
    // the defect this replaces.
    const occurrences = text().split("subscription.limitReached").length - 1;
    expect(occurrences).toBe(1);
  });

  it("announces nothing on mount — no toast, no native dialog, no buzz", async () => {
    const showAlert = vi.fn();
    const notificationOccurred = vi.fn();
    (window as { Telegram?: unknown }).Telegram = {
      WebApp: { showAlert, HapticFeedback: { notificationOccurred } },
    };
    api.getActionPolicy.mockResolvedValue({
      limitReached: true,
      activeSubscriptionCount: 1,
      maxSubscriptions: 1,
    });

    render();
    await settle();

    expect(toast.warning).not.toHaveBeenCalled();
    expect(showAlert).not.toHaveBeenCalled();
    expect(notificationOccurred).not.toHaveBeenCalled();
  });

  it("still refuses a tap, out loud, without the blocking dialog", async () => {
    const showAlert = vi.fn();
    (window as { Telegram?: unknown }).Telegram = { WebApp: { showAlert } };
    api.getActionPolicy.mockResolvedValue({
      limitReached: true,
      activeSubscriptionCount: 1,
      maxSubscriptions: 1,
    });
    render();
    await settle();

    const card = container?.querySelector<HTMLButtonElement>("[data-testid='plan-p1']");
    await act(async () => {
      card?.click();
    });

    // Transient feedback for an action the user just took is the one place a
    // toast is right — but the modal is not, because the banner is still on
    // screen behind it and nothing is navigating away.
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(showAlert).not.toHaveBeenCalled();
    // And the refusal has to be real: no selection, no route change.
    expect(selectPlan).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves an under-capacity user completely alone", async () => {
    api.getActionPolicy.mockResolvedValue({
      limitReached: false,
      activeSubscriptionCount: 0,
      maxSubscriptions: 2,
    });
    render();
    await settle();

    expect(container?.querySelector("[role='status']")).toBeNull();
    expect(text()).not.toContain("subscription.limitReached");

    const card = container?.querySelector<HTMLButtonElement>("[data-testid='plan-p1']");
    await act(async () => {
      card?.click();
    });

    expect(toast.warning).not.toHaveBeenCalled();
    expect(selectPlan).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/purchase");
  });
});
