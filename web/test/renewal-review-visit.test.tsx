// @vitest-environment jsdom

/**
 * The renewal review acts for the visit it is on screen for, and only on a
 * price that visit received.
 *
 * The wizard swaps steps under `AnimatePresence mode="wait"`: the step being
 * left stays mounted for its 200 ms exit and keeps re-rendering from the store.
 * A review leaving for plan selection because the chosen plan was withdrawn saw
 * that choice dropped under it, asked for a price on what was left, and handed
 * the subscriber over again on that answer: a second "This plan is no longer
 * available" notice and another reload. So this file does NOT mock
 * `motion/react`; the exit window is where that happened.
 *
 * Offline, React Query pauses the re-price a review starts on arrival instead of
 * running it. Paused is neither loading nor fetching, so the review offered Pay
 * on the copy an earlier visit had left.
 *
 * One answer can give both reasons to choose a plan again, and each reason told
 * the subscriber and returned them to plan selection on its own.
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
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast }));
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
  SubscriptionSelectCard: ({ subtitle, onSelect }: { subtitle?: string; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {subtitle}
    </button>
  ),
}));

import { TipCard } from "../src/components/ui/tip-card";
import RenewalPage from "../src/features/renewal/renewal-page";
import { useRenewalStore } from "../src/stores/renewal.store";

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };
const PLAN_LIVE = { id: "plan-live", name: "Live plan", isTrial: false, durations: [{ id: "d-30", days: 30 }] };
const PLAN_Q = { id: "plan-q", name: "Plan Q", isTrial: false, durations: [{ id: "d-30", days: 30 }] };
/** The store's own action, put back after a case that watches it. */
const STORE_GO_BACK = useRenewalStore.getState().goBack;

type RenewalRead = {
  readonly subscriptionIds?: string[];
  readonly gatewayType?: string;
  readonly plans?: { subscriptionId: string; planId: string }[];
};

type Item = ReturnType<typeof item>;

/** A renewal item as the panel prices it; `planId: null` with no amount when it cannot. */
function item(subscriptionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    subscriptionId,
    planId: "plan-p" as string | null,
    planName: "plan-p" as string | null,
    durationDays: 30 as number | null,
    availableDurations: [{ id: "d-30", days: 30 }],
    currency: "RUB" as string | null,
    amount: "200" as string | null,
    discountPercent: 0,
    renewable: true,
    requiresPlanSelection: false,
    warnings: [] as { code: string; message: string }[],
    ...overrides,
  };
}

/** A subscription with no plan of its own (panel-imported), before a plan is chosen. */
function needsPlan(subscriptionId: string): Item {
  return item(subscriptionId, {
    planId: null,
    planName: null,
    durationDays: null,
    availableDurations: [],
    currency: null,
    amount: null,
    requiresPlanSelection: true,
    warnings: [{ code: "PLAN_SELECTION_REQUIRED", message: "A plan must be selected." }],
  });
}

/** `quoteSubscriptionRenewal` when the plan chosen for it is no longer among the targets. */
function choiceWithdrawn(subscriptionId: string): Item {
  return { ...needsPlan(subscriptionId), renewable: false, requiresPlanSelection: false };
}

/** The panel's answer: a total only when every item is priced. */
function answer(items: readonly Item[]) {
  const priced = items.filter((entry) => entry.amount !== null);
  const allPriced = priced.length > 0 && priced.length === items.length;
  return {
    userId: "user-1",
    items,
    currency: priced.length > 0 ? "RUB" : null,
    total: allPriced ? String(priced.reduce((sum, entry) => sum + Number(entry.amount), 0)) : null,
  };
}

function networkError(): Error {
  return Object.assign(new Error("Network Error"), { isAxiosError: true, code: "ERR_NETWORK" });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function settleLong(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await settle();
}

/**
 * Lets real time pass in short act() turns, so each turn's React work lands
 * while the step animation is still running. One long act() would hold every
 * update back to its end.
 */
async function wait(ms: number, eachTurn?: () => void): Promise<void> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    eachTurn?.();
  }
}

/** Everything the screen showed, turn by turn, and every alert on it. */
function screens(): { readonly seen: string[]; readonly alerts: string[]; readonly look: () => void } {
  const seen: string[] = [];
  const alerts: string[] = [];
  return {
    seen,
    alerts,
    look: () => {
      seen.push(text());
      for (const alert of container?.querySelectorAll('[role="alert"]') ?? []) alerts.push(alert.textContent ?? "");
    },
  };
}

/** Like `wait`, until `condition` holds; fails with what the screen shows if it never does. */
async function waitUntil(condition: () => boolean, eachTurn?: () => void, timeoutMs = 4_000): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > until) throw new Error(`gave up waiting; the screen shows: ${text()}`);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    eachTurn?.();
  }
}

/** Presses the on-screen button with exactly this label, as the subscriber would. */
async function press(label: string): Promise<void> {
  const target = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`no "${label}" button on screen; it shows: ${text()}`);
  act(() => target.click());
  await settle();
}

/** Long enough for the 200 ms step exit, and for the step that follows to mount. */
const PAST_THE_STEP_ANIMATION_MS = 450;

function text(): string {
  return container?.textContent ?? "";
}

function buttonLabels(): string[] {
  return [...(container?.querySelectorAll("button") ?? [])].map((button) => button.textContent?.trim() ?? "");
}

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  await settle();
  await settle();
}

/** The review's reads: the only renewal-options reads that name a gateway. */
function reviewReads(): RenewalRead[] {
  return api.getRenewalOptions.mock.calls
    .map(([input]) => input as RenewalRead | undefined)
    .filter((input): input is RenewalRead => input?.gatewayType !== undefined);
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
  api.getEnabledGateways.mockResolvedValue([GATEWAY_WIRE]);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getPlans.mockResolvedValue([PLAN_LIVE]);
  api.getPartnerInfo.mockResolvedValue(null);
});

afterEach(() => {
  onlineManager.setOnline(true);
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useRenewalStore.getState().reset();
  // `reset` restores the state, not the actions.
  useRenewalStore.setState({ goBack: STORE_GO_BACK });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("renewal review: a review that is no longer the step on screen", () => {
  it("announces a withdrawn plan once, and asks for no price while it animates out", async () => {
    // A plan-less subscription renewed onto a plan the operator has stopped
    // selling. The review releases the choice and returns to plan selection.
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-1", status: "ACTIVE", isTrial: false, plan: null }],
    });
    api.getRenewalOptions.mockImplementation(async (input?: RenewalRead) => {
      const chosen = input?.plans?.find((entry) => entry.subscriptionId === "sub-1")?.planId;
      if (chosen === undefined) return answer([needsPlan("sub-1")]);
      if (chosen === "plan-gone") return answer([choiceWithdrawn("sub-1")]);
      return answer([item("sub-1", { planId: chosen, planName: "Live plan", amount: "100" })]);
    });
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-1"],
      selectedDurations: { "sub-1": 30 },
      selectedPlans: { "sub-1": "plan-gone" },
      selectedGateway: GATEWAY,
    });

    await mount(<RenewalPage />);
    const exit = screens();
    await wait(PAST_THE_STEP_ANIMATION_MS, exit.look);

    expect(
      reviewReads().map((read) => read.plans ?? []),
      "the review asked for a price again while it was leaving",
    ).toEqual([[{ subscriptionId: "sub-1", planId: "plan-gone" }]]);
    expect(toast.warning, "the leaving review announced the withdrawal a second time").toHaveBeenCalledTimes(1);
    expect(
      exit.seen.filter((screen) => screen.includes("renewal.priceError")),
      "the leaving review flashed a price error on its way out",
    ).toEqual([]);
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(text()).toContain("Live plan");
  });

  it("hands a deleted plan over once, with no error flashed while it animates out", async () => {
    // sub-a's own plan was deleted after the list was read: the review sends
    // the subscriber to choose one, and keeps its loader while it leaves.
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } }],
    });
    api.getRenewalOptions.mockImplementation(async (input?: RenewalRead) => {
      const chosen = input?.plans?.find((entry) => entry.subscriptionId === "sub-a")?.planId;
      if (chosen !== undefined) return answer([item("sub-a", { planId: chosen, amount: "100" })]);
      return answer([needsPlan("sub-a")]);
    });
    queryClient.setQueryData(["renewal-options", {}, {}], answer([item("sub-a")]));
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedGateway: GATEWAY,
    });

    await mount(<RenewalPage />);
    const exit = screens();
    await wait(PAST_THE_STEP_ANIMATION_MS, exit.look);

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(
      exit.seen.filter((screen) => screen.includes("renewal.priceError")),
      "the leaving review flashed a price error on its way out",
    ).toEqual([]);
    expect(reviewReads()).toHaveLength(1);
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(text()).toContain("Live plan");
  });

  it("keeps its loader while it leaves, when its new selection holds the answer an earlier visit left", async () => {
    // Two withdrawals in one pass through the wizard. sub-a's own plan is
    // deleted: the first review sends the subscriber to choose a plan, and its
    // answer (no price, a plan must be chosen) stays cached. Plan Q, chosen
    // there with the same 30-day term, is taken off sale before the second
    // review, which lets that choice go. Its selection is then the first
    // review's again, and for its whole exit it showed that cached answer: the
    // price error, announced as an alert.
    let planQOnSale = true;
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } }],
    });
    api.getPlans.mockImplementation(async () => (planQOnSale ? [PLAN_Q] : [PLAN_LIVE]));
    api.getRenewalOptions.mockImplementation(async (input?: RenewalRead) => {
      const chosen = input?.plans?.find((entry) => entry.subscriptionId === "sub-a")?.planId;
      if (chosen === undefined) return answer([needsPlan("sub-a")]);
      planQOnSale = false;
      return answer([choiceWithdrawn("sub-a")]);
    });
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedDurations: { "sub-a": 30 },
      selectedGateway: GATEWAY,
    });
    const journey = screens();

    await mount(<RenewalPage />);
    await waitUntil(() => buttonLabels().includes("Plan Q"), journey.look);
    await press("Plan Q");
    await press("renewal.continue");
    // Past the gateway, the second review, and that review's exit.
    await waitUntil(
      () => useRenewalStore.getState().step === "plan" && buttonLabels().includes("Live plan"),
      journey.look,
    );

    expect(
      reviewReads().map((read) => read.plans ?? []),
      "the wizard did not go through both reviews",
    ).toEqual([[], [{ subscriptionId: "sub-a", planId: "plan-q" }]]);
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(journey.alerts, "the leaving review announced a price error nobody asked it for").toEqual([]);
    expect(
      journey.seen.filter((screen) => screen.includes("renewal.priceError")),
      "the leaving review showed the answer an earlier visit left",
    ).toEqual([]);
    expect(useRenewalStore.getState().selectedPlans).toEqual({});
  }, 15_000);

  it("fades out the answer it showed when it leaves on that answer, instead of swapping in its loader", async () => {
    // Back from a price it could not calculate keeps the selection that answer
    // came for (so does Pay), so the leaving review still has its own answer.
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } }],
    });
    api.getRenewalOptions.mockRejectedValue(networkError());
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedGateway: GATEWAY,
    });

    await mount(<RenewalPage />);
    await settleLong();
    expect(text()).toContain("renewal.priceError");

    let loaderSeen = false;
    const exit = screens();
    await press("renewal.back");
    await waitUntil(
      () => text().includes("purchase.gateway.title"),
      () => {
        exit.look();
        if (container?.querySelector(".animate-spin")) loaderSeen = true;
      },
    );

    expect(useRenewalStore.getState().step).toBe("gateway");
    expect(loaderSeen, "the leaving review swapped the answer it showed for its loader").toBe(false);
    expect(exit.seen.some((screen) => screen.includes("renewal.priceError")), "no exit was sampled").toBe(true);
    expect(reviewReads()).toHaveLength(1);
  });

  it("does not act on a price that lands after it stopped being the step", async () => {
    // Nothing in the review moves the wizard on while its price is out; this
    // pins that a review that is not the current step never acts, whatever
    // moved the step. The answer carries both hand-offs: sub-1's chosen plan
    // withdrawn, and sub-a's own plan deleted.
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [
        { id: "sub-1", status: "ACTIVE", isTrial: false, plan: null },
        { id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } },
      ],
    });
    let releaseReview: (() => void) | null = null;
    api.getRenewalOptions.mockImplementation((input?: RenewalRead) => {
      if (input?.gatewayType === undefined) return Promise.resolve(answer([needsPlan("sub-1"), needsPlan("sub-a")]));
      return new Promise((resolve) => {
        releaseReview = () => resolve(answer([choiceWithdrawn("sub-1"), needsPlan("sub-a")]));
      });
    });
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-1", "sub-a"],
      selectedDurations: { "sub-1": 30 },
      selectedPlans: { "sub-1": "plan-gone" },
      selectedGateway: GATEWAY,
    });

    await mount(<RenewalPage />);
    await settleLong();
    expect(releaseReview, "the review never asked for its price").not.toBeNull();
    const baseReads = api.getRenewalOptions.mock.calls.length - reviewReads().length;

    act(() => useRenewalStore.getState().goBack("gateway"));
    await settle();
    act(() => releaseReview?.());
    await wait(PAST_THE_STEP_ANIMATION_MS);

    expect(toast.warning, "a review that had left announced a plan change").not.toHaveBeenCalled();
    expect(useRenewalStore.getState().step, "a review that had left moved the wizard").toBe("gateway");
    expect(useRenewalStore.getState().selectedPlans, "a review that had left released a choice").toEqual({
      "sub-1": "plan-gone",
    });
    expect(
      api.getRenewalOptions.mock.calls.length - reviewReads().length,
      "a review that had left dropped the renewal options",
    ).toBe(baseReads);
  });
});

describe("renewal review: one answer with two reasons to choose a plan again", () => {
  it("says so once and returns to plan selection once, which then asks for both plans", async () => {
    // sub-1 has no plan of its own, and the plan chosen for it is withdrawn;
    // sub-a's own plan is deleted. One answer carries both, and each reason
    // announced itself and returned the subscriber to plan selection on its own.
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [
        { id: "sub-1", status: "ACTIVE", isTrial: false, plan: null },
        { id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } },
      ],
    });
    api.getRenewalOptions.mockImplementation(async (input?: RenewalRead) =>
      input?.gatewayType === undefined
        ? answer([needsPlan("sub-1"), needsPlan("sub-a")])
        : answer([choiceWithdrawn("sub-1"), needsPlan("sub-a")]),
    );
    // The list the subscriber ticked, still held: sub-a priced on its own plan.
    // Plan selection decides from it, so on this copy it would ask for sub-1 only.
    queryClient.setQueryData(["renewal-options", {}, {}], answer([needsPlan("sub-1"), item("sub-a")]));
    const goBack = vi.fn(STORE_GO_BACK);
    const resets = vi.spyOn(queryClient, "resetQueries");
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-1", "sub-a"],
      selectedDurations: { "sub-1": 30 },
      selectedPlans: { "sub-1": "plan-gone" },
      selectedGateway: GATEWAY,
      goBack,
    });

    await mount(<RenewalPage />);
    // Past the review's exit: plan selection mounts only once it is over.
    await waitUntil(() => buttonLabels().includes("Live plan"));

    expect(toast.warning, "one answer was announced twice").toHaveBeenCalledTimes(1);
    expect(goBack.mock.calls, "one answer handed the subscriber over twice").toEqual([["plan"]]);
    const dropped = resets.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey)).sort();
    expect(dropped, "the lists were dropped once per reason instead of once").toEqual([
      '["plans"]',
      '["renewal-options"]',
    ]);
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(useRenewalStore.getState().selectedPlans, "the withdrawn choice was kept").toEqual({});
    expect(
      buttonLabels().filter((label) => label === "Live plan"),
      "plan selection did not ask for both subscriptions",
    ).toHaveLength(2);
  });
});

describe("renewal review: offline", () => {
  beforeEach(() => {
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } }],
    });
    // What the panel charges for sub-a now.
    api.getRenewalOptions.mockResolvedValue(answer([item("sub-a", { amount: "250" })]));
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedGateway: GATEWAY,
    });
  });

  it("waits for this visit's price instead of offering Pay on the copy an earlier visit left", async () => {
    queryClient.setQueryData(["renewal-review", ["sub-a"], "YOOKASSA", {}, {}], answer([item("sub-a", { amount: "200" })]));
    onlineManager.setOnline(false);

    await mount(<RenewalPage />);
    await settleLong();

    expect(buttonLabels(), "Pay offered on a price nobody confirmed").not.toContain("renewal.pay");
    expect(text()).not.toContain("200");
    expect(text()).not.toContain("renewal.priceError");
    expect(reviewReads()).toHaveLength(0);

    act(() => onlineManager.setOnline(true));
    await settleLong();

    expect(buttonLabels()).toContain("renewal.pay");
    expect(text()).toContain("250");
    expect(text()).not.toContain("200");
  });

  it("waits with nothing cached, instead of saying the price cannot be calculated", async () => {
    onlineManager.setOnline(false);

    await mount(<RenewalPage />);
    await settleLong();

    expect(text(), "an offline wait was reported as a price that cannot be calculated").not.toContain(
      "renewal.priceError",
    );
    expect(buttonLabels()).not.toContain("renewal.pay");

    act(() => onlineManager.setOnline(true));
    await settleLong();

    expect(buttonLabels()).toContain("renewal.pay");
    expect(text()).toContain("250");
  });
});

describe("renewal review: a price it cannot calculate", () => {
  it("is announced: the error reaches the page as an alert", async () => {
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [{ id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } }],
    });
    api.getRenewalOptions.mockRejectedValue(networkError());
    useRenewalStore.setState({
      step: "review",
      navDirection: "forward",
      selectedSubscriptionIds: ["sub-a"],
      selectedGateway: GATEWAY,
    });

    await mount(<RenewalPage />);
    await settleLong();

    const alert = container?.querySelector<HTMLElement>('[role="alert"]');
    expect(alert, "the price error carries no alert role").not.toBeNull();
    expect(alert?.textContent).toBe("renewal.priceError");
    expect(alert?.className, "the role landed somewhere other than the card").toContain("border-l-4");
  });

  it("TipCard hands its other props to its root and still merges a caller's className", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <TipCard tone="warning" id="tip" aria-live="polite" data-kind="hint" className="mt-3">
          Text
        </TipCard>,
      );
    });

    const card = container.firstElementChild as HTMLElement | null;
    expect(card?.id).toBe("tip");
    expect(card?.getAttribute("aria-live")).toBe("polite");
    expect(card?.getAttribute("data-kind")).toBe("hint");
    expect(card?.className).toContain("mt-3");
    expect(card?.className, "a caller's className replaced the card's own").toContain("rounded-xl");
    expect(card?.className).toContain("bg-amber-500/10");
    expect(card?.textContent).toBe("Text");
  });
});
