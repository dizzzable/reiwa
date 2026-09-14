// @vitest-environment jsdom

/**
 * A renewal term the plan offers is the subscriber's to choose.
 *
 * The subscription list is also where the renewal term is picked: a row grows a
 * term picker whenever the plan offers more than one. With exactly ONE
 * renewable subscription the list used to be skipped — the wizard selected it
 * and went straight to the gateway — so the picker never appeared and every
 * such renewal silently used the default term. Owner's rule: auto-picking is
 * right only when there is nothing to pick.
 *
 * Mounted the way the app mounts the wizard, with the app's query defaults, so
 * the choice is followed all the way into the review request and the checkout.
 */

import { notifyManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
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

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
// The count is part of the label, so "90 days" and "30 days" are different
// buttons on screen — exactly as they are for the subscriber.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}#${options.count}`,
  }),
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
vi.mock("../src/features/plans/tariff-card", () => ({
  TariffCard: ({ plan, onClick }: { plan: { name: string }; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {plan.name}
    </button>
  ),
}));
vi.mock("@/components/subscription/subscription-select-card", () => ({
  SubscriptionSelectCard: ({
    subtitle,
    selected,
    onSelect,
  }: {
    subtitle?: string;
    selected: boolean;
    onSelect: () => void;
  }) => (
    <button type="button" aria-pressed={selected} data-testid="subscription-row" onClick={onSelect}>
      {subtitle}
    </button>
  ),
}));

import RenewalPage from "../src/features/renewal/renewal-page";
import { useRenewalStore } from "../src/stores/renewal.store";

const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };
/** Deliberately not the default term, so "the choice was applied" and "ignored" differ. */
const CHOSEN_DAYS = 90;
const PRICE_BY_DAYS: Record<number, string> = { 30: "100", 90: "270", 180: "500" };

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

function buttonLabelsOnScreen(): string[] {
  return [...(container?.querySelectorAll("button") ?? [])].map((button) => button.textContent?.trim() ?? "");
}

async function press(label: string): Promise<void> {
  const target = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`no "${label}" button on screen; it shows: ${text()}`);
  act(() => target.click());
  await settle();
  await settle();
}

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  for (let i = 0; i < 4; i += 1) await settle();
}

/** A subscription on a plan of its own, renewable for any of `terms`. */
function renewableItem(terms: readonly number[], days: number) {
  return {
    subscriptionId: "sub-1",
    planId: "plan-1",
    planName: "Plan",
    durationDays: days,
    availableDurations: terms.map((term) => ({ id: `d-${term}`, days: term })),
    currency: "RUB",
    amount: PRICE_BY_DAYS[days] ?? "100",
    discountPercent: 0,
    renewable: true,
    requiresPlanSelection: false,
    warnings: [],
  };
}

/** Serves the panel's renewal pricing for a plan offering `terms`, 30 days by default. */
function servePlanWithTerms(terms: readonly number[]): void {
  api.getRenewalOptions.mockImplementation(
    async (input?: { durations?: { subscriptionId: string; days: number }[] }) => {
      const days = input?.durations?.find((entry) => entry.subscriptionId === "sub-1")?.days ?? 30;
      const item = renewableItem(terms, days);
      return { userId: "user-1", items: [item], currency: "RUB", total: item.amount };
    },
  );
}

/** The review's request: the only renewal-options read that names a gateway. */
function reviewRequests(): { durations?: unknown; gatewayType?: string }[] {
  return api.getRenewalOptions.mock.calls
    .map(([input]) => input as { durations?: unknown; gatewayType?: string } | undefined)
    .filter((input): input is { durations?: unknown; gatewayType?: string } => input?.gatewayType !== undefined);
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
    subscriptions: [{ id: "sub-1", status: "ACTIVE", isTrial: false, plan: { name: "Plan" } }],
  });
  api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
  api.getPaymentMethods.mockResolvedValue({ methods: [], total: 0 });
  api.getPartnerInfo.mockResolvedValue(null);
  // Held open: the spec is about what the checkout is asked for, not what follows.
  api.createRenewalCheckout.mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  onlineManager.setOnline(true);
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useRenewalStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("renewal: the only renewable subscription", () => {
  it("stays on the list when its plan offers several terms, and renews for the term picked there", async () => {
    servePlanWithTerms([30, 90, 180]);

    await mount(<RenewalPage />);

    expect(useRenewalStore.getState().step, "the term picker was skipped").toBe("subscriptions");
    expect(useRenewalStore.getState().selectedSubscriptionIds, "the only subscription is not pre-selected").toEqual([
      "sub-1",
    ]);
    expect(text()).toContain("renewal.durationLabel");

    await press(`purchase.duration.days#${CHOSEN_DAYS}`);
    await press("renewal.continue");
    for (let i = 0; i < 4; i += 1) await settle();

    expect(useRenewalStore.getState().step).toBe("review");
    const review = reviewRequests();
    expect(review.length, "the review was never priced").toBeGreaterThan(0);
    for (const request of review) {
      expect(request.durations, "the review priced a term the subscriber did not pick").toEqual([
        { subscriptionId: "sub-1", days: CHOSEN_DAYS },
      ]);
    }

    await press("renewal.pay");

    expect(api.createRenewalCheckout).toHaveBeenCalledTimes(1);
    const [ids, gateway, quote, durations] = api.createRenewalCheckout.mock.calls[0] ?? [];
    expect(ids).toEqual(["sub-1"]);
    expect(gateway).toBe("YOOKASSA");
    expect(quote).toEqual({ amount: PRICE_BY_DAYS[CHOSEN_DAYS], currency: "RUB" });
    expect(durations, "the checkout renews for a term the subscriber did not pick").toEqual([
      { subscriptionId: "sub-1", days: CHOSEN_DAYS },
    ]);
  });

  it("lets the subscriber untick the pre-selected subscription without it snapping back", async () => {
    servePlanWithTerms([30, 90, 180]);

    await mount(<RenewalPage />);
    const row = container?.querySelector<HTMLButtonElement>('[data-testid="subscription-row"]');
    expect(row?.getAttribute("aria-pressed")).toBe("true");

    act(() => row?.click());
    for (let i = 0; i < 3; i += 1) await settle();

    expect(useRenewalStore.getState().selectedSubscriptionIds).toEqual([]);
    expect(useRenewalStore.getState().step).toBe("subscriptions");
  });

  it("still skips the list when its plan offers a single term", async () => {
    servePlanWithTerms([30]);

    await mount(<RenewalPage />);
    for (let i = 0; i < 4; i += 1) await settle();

    // One subscription, one term, one gateway: nothing to choose on the way.
    expect(useRenewalStore.getState().selectedSubscriptionIds).toEqual(["sub-1"]);
    expect(useRenewalStore.getState().step).toBe("review");
    const review = reviewRequests();
    expect(review.length).toBeGreaterThan(0);
    expect(review[0]?.durations).toBeUndefined();
  });

  it("still opens the plan step for a subscription with no plan, where the term is chosen with the plan", async () => {
    api.getPlans.mockResolvedValue([
      { id: "plan-live", name: "Live plan", isTrial: false, durations: [{ id: "d-30", days: 30 }] },
    ]);
    api.getRenewalOptions.mockResolvedValue({
      userId: "user-1",
      items: [
        {
          ...renewableItem([], 30),
          planId: null,
          planName: null,
          durationDays: null,
          currency: null,
          amount: null,
          requiresPlanSelection: true,
          warnings: [{ code: "PLAN_SELECTION_REQUIRED", message: "A plan must be selected." }],
        },
      ],
      currency: null,
      total: null,
    });

    await mount(<RenewalPage />);

    expect(useRenewalStore.getState().selectedSubscriptionIds).toEqual(["sub-1"]);
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(text()).toContain("Live plan");
  });

  it("says a term's price could not be read, with a retry, instead of that nothing is renewable", async () => {
    servePlanWithTerms([30, 90, 180]);
    // An expired trial kept in the list: a read that lists nothing must not
    // send this subscriber to /upgrade either.
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [
        { id: "sub-1", status: "ACTIVE", isTrial: false, plan: { name: "Plan" } },
        { id: "sub-t", status: "EXPIRED", isTrial: true, plan: { name: "Trial" } },
      ],
    });
    const serveTerms = api.getRenewalOptions.getMockImplementation();
    // The list itself was read; the price for the term picked on it is not.
    let termReadFails = true;
    api.getRenewalOptions.mockImplementation(async (input?: { durations?: unknown[] }) => {
      if (termReadFails && (input?.durations?.length ?? 0) > 0) {
        throw Object.assign(new Error("Network Error"), { isAxiosError: true, code: "ERR_NETWORK" });
      }
      return serveTerms?.(input);
    });

    await mount(<RenewalPage />);
    await press(`purchase.duration.days#${CHOSEN_DAYS}`);
    for (let i = 0; i < 4; i += 1) await settle();

    expect(useRenewalStore.getState().step).toBe("subscriptions");
    expect(text(), "a price that could not be read was presented as nothing to renew").not.toContain(
      "renewal.noneRenewable",
    );
    expect(text()).toContain("renewal.loadError");
    expect(navigate, "a read that failed was taken for an answer that nothing is renewable").not.toHaveBeenCalled();

    termReadFails = false;
    await press("common.retry");
    for (let i = 0; i < 4; i += 1) await settle();

    expect(text()).not.toContain("renewal.loadError");
    expect(text()).toContain(`purchase.duration.days#${CHOSEN_DAYS}`);
    expect(useRenewalStore.getState().selectedDurations).toEqual({ "sub-1": CHOSEN_DAYS });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("waits for a term's price while offline, instead of saying nothing is renewable", async () => {
    servePlanWithTerms([30, 90, 180]);

    await mount(<RenewalPage />);
    expect(text()).toContain("renewal.durationLabel");

    act(() => onlineManager.setOnline(false));
    await press(`purchase.duration.days#${CHOSEN_DAYS}`);
    for (let i = 0; i < 4; i += 1) await settle();

    expect(text(), "a read paused offline was presented as nothing to renew").not.toContain("renewal.noneRenewable");
    expect(text()).not.toContain("renewal.loadError");
    expect(buttonLabelsOnScreen()).not.toContain("renewal.continue");

    act(() => onlineManager.setOnline(true));
    for (let i = 0; i < 4; i += 1) await settle();

    expect(text()).toContain(`purchase.duration.days#${CHOSEN_DAYS}`);
    expect(buttonLabelsOnScreen()).toContain("renewal.continue");
  });
});
