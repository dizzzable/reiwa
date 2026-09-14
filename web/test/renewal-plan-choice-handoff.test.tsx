// @vitest-environment jsdom

/**
 * The review's hand-off to plan choice must not bounce back into the review.
 *
 * A renewal review that finds a selected subscription asking for a plan (its
 * own plan was deleted) says so, drops the renewal options and the catalogue,
 * and returns to plan selection. Plan selection skips to the gateway when no
 * selected subscription needs a plan, and a single gateway with no saved card
 * advances to the review by itself. Two gaps turned that into a loop of
 * "This plan is no longer available" notices:
 *
 *   - a renewal-options read that FAILED left plan selection with no targets,
 *     so it skipped to the gateway, and the gateway went on to the review;
 *   - the review answered from the copy it had cached, fresh for 30 s, which
 *     still said a plan must be chosen: another notice, another hand-off.
 *
 * Mounted the way the app mounts the wizard: store advanced into the step, the
 * app's query defaults minus retries (a retry only slows each lap down).
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
  SubscriptionSelectCard: ({ subtitle, onSelect }: { subtitle?: string; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {subtitle}
    </button>
  ),
}));

import RenewalPage from "../src/features/renewal/renewal-page";
import { useRenewalStore } from "../src/stores/renewal.store";

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
const GATEWAY_WIRE = { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true };
const PLAN_LIVE = { id: "plan-live", name: "Live plan", isTrial: false, durations: [{ id: "d-30", days: 30 }] };

type RenewalRead = {
  readonly subscriptionIds?: string[];
  readonly gatewayType?: string;
  readonly plans?: { subscriptionId: string; planId: string }[];
};

/** sub-a renewed on a plan: its own, or the one chosen for it. */
function pricedItem(planId: string, amount: string) {
  return {
    subscriptionId: "sub-a",
    planId,
    planName: planId,
    durationDays: 30,
    availableDurations: [{ id: "d-30", days: 30 }],
    currency: "RUB",
    amount,
    discountPercent: 0,
    renewable: true,
    requiresPlanSelection: false,
    warnings: [],
  };
}

/** `quoteSubscriptionRenewal` for sub-a once its own plan is deleted and no plan was chosen. */
function awaitingItem() {
  return {
    subscriptionId: "sub-a",
    planId: null,
    planName: null,
    durationDays: null,
    availableDurations: [],
    currency: null,
    amount: null,
    discountPercent: 0,
    renewable: true,
    requiresPlanSelection: true,
    warnings: [{ code: "ARCHIVED_PLAN_REPLACEMENT", message: "archived" }],
  };
}

/**
 * An expired trial the subscriber still holds. The subscription list is history
 * (rezeis leaves out only deleted subscriptions), so a trial stays in it beside
 * the paid subscription bought after it, and the panel lists it as never
 * renewable.
 */
function trialItem() {
  return {
    subscriptionId: "sub-t",
    planId: "plan-trial",
    planName: "Trial",
    durationDays: null,
    availableDurations: [],
    currency: null,
    amount: null,
    discountPercent: 0,
    renewable: false,
    requiresPlanSelection: false,
    warnings: [{ code: "TRIAL_NOT_RENEWABLE", message: "trial" }],
  };
}

function networkError(): Error {
  return Object.assign(new Error("Network Error"), { isAxiosError: true, code: "ERR_NETWORK" });
}

/**
 * Every lap of a loop re-reads the renewal options (the hand-off drops them),
 * and a review that re-prices on arrival reads its price too; a subscription
 * step that re-mounts on a failed read asks for that read again. Past this many
 * reads of one kind (options, review price, subscriptions) the panel stops
 * answering, so a loop ends in a wizard stuck on a loader, which the assertions
 * can see, and not in a test that never returns (React's `act` keeps flushing a
 * loop that never settles). No case here needs more than three of any kind.
 */
const READ_LIMIT = 6;

/** What the panel holds, and which of its reads fail. */
let panel: {
  planDeleted: boolean;
  /** Every renewal-options read that names no gateway: the base list plan selection decides from. */
  optionsReadFails: boolean;
  /** The review's read, the only one that names a gateway. */
  reviewReadFails: boolean;
  /** The operator puts sub-a's plan back on sale as soon as a review has been answered. */
  restorePlanAfterReview: boolean;
  /** The subscriber also holds an expired trial (see `holdTrial`). */
  trialInList: boolean;
  /** The subscription list read fails. */
  subscriptionsReadFails: boolean;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Enough turns for several laps of the loop, if there is one. */
async function settleLong(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await settle();
}

function text(): string {
  return container?.textContent ?? "";
}

function buttonLabels(): string[] {
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
  await settle();
  await settle();
}

/** How many times the review asked for a price. */
function reviewReads(): number {
  return api.getRenewalOptions.mock.calls.filter(
    ([input]) => (input as RenewalRead | undefined)?.gatewayType !== undefined,
  ).length;
}

/** How many times the base list (every renewal-options read that names no gateway) was asked for. */
function optionsReads(): number {
  return api.getRenewalOptions.mock.calls.length - reviewReads();
}

/** The subscription list as the subscriber ticked it, still held: sub-a priced on its own plan. */
function seedTickedList(): void {
  queryClient.setQueryData(["renewal-options", {}, {}], {
    userId: "user-1",
    items: panel.trialInList ? [pricedItem("plan-p", "200"), trialItem()] : [pricedItem("plan-p", "200")],
    currency: "RUB",
    total: "200",
  });
}

/** The subscriber also holds an expired trial, listed by both reads. */
function holdTrial(): void {
  panel.trialInList = true;
}

/** Opens the wizard on the review, sub-a selected, the only gateway chosen. */
function enterReview(): void {
  useRenewalStore.setState({
    step: "review",
    navDirection: "forward",
    selectedSubscriptionIds: ["sub-a"],
    selectedGateway: GATEWAY,
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
  panel = {
    planDeleted: true,
    optionsReadFails: false,
    reviewReadFails: false,
    restorePlanAfterReview: false,
    trialInList: false,
    subscriptionsReadFails: false,
  };
  const reads = { options: 0, review: 0, subscriptions: 0 };
  api.getRenewalOptions.mockImplementation(async (input?: RenewalRead) => {
    const review = input?.gatewayType !== undefined;
    if (++reads[review ? "review" : "options"] > READ_LIMIT) return new Promise(() => undefined);
    if (review ? panel.reviewReadFails : panel.optionsReadFails) throw networkError();
    const chosen = input?.plans?.find((entry) => entry.subscriptionId === "sub-a")?.planId;
    const item =
      chosen !== undefined
        ? pricedItem(chosen, "100")
        : panel.planDeleted
          ? awaitingItem()
          : pricedItem("plan-p", "200");
    if (review && panel.restorePlanAfterReview) panel.planDeleted = false;
    // The review names the subscriptions it prices; the base list holds them all.
    const items = !review && panel.trialInList ? [item, trialItem()] : [item];
    return { userId: "user-1", items, currency: item.currency, total: item.amount };
  });
  api.getAllSubscriptions.mockImplementation(async () => {
    if (++reads.subscriptions > READ_LIMIT) return new Promise(() => undefined);
    if (panel.subscriptionsReadFails) throw networkError();
    return {
      subscriptions: [
        { id: "sub-a", status: "ACTIVE", isTrial: false, plan: { name: "P" } },
        ...(panel.trialInList ? [{ id: "sub-t", status: "EXPIRED", isTrial: true, plan: { name: "Trial" } }] : []),
      ],
    };
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: an offline case's notice hook would
  // otherwise keep toggling the connection in every later case.
  toast.warning.mockReset();
});

describe("renewal: the review's hand-off to plan choice", () => {
  it("stops on plan selection with a retry when the renewal options cannot be reloaded", async () => {
    // The hand-off drops the options, and the reload fails: a panel hiccup, a
    // dropped mobile connection, the BFF answering 502.
    panel.optionsReadFails = true;
    seedTickedList();
    enterReview();

    await mount(<RenewalPage />);
    await settleLong();

    expect(
      toast.warning,
      "the notice repeats: the wizard is bouncing between plan selection and the review",
    ).toHaveBeenCalledTimes(1);
    expect(
      useRenewalStore.getState().step,
      "plan selection moved on without knowing which subscription needs a plan",
    ).toBe("plan");
    expect(reviewReads(), "the review was entered again").toBe(1);
    expect(text()).toContain("plans.empty");
    expect(buttonLabels()).toContain("common.retry");
    expect(buttonLabels()).not.toContain("renewal.pay");

    // The panel answers again: Retry brings the choice back, and the way on works.
    panel.optionsReadFails = false;
    await press("common.retry");
    expect(text()).toContain("Live plan");

    await press("Live plan");
    await press("renewal.continue");
    await settleLong();

    expect(useRenewalStore.getState().step).toBe("review");
    expect(buttonLabels()).toContain("renewal.pay");
    expect(text()).toContain("100");
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("waits on plan selection while the device is offline, instead of moving on without an answer", async () => {
    // Offline, React Query pauses the reload instead of failing it: nothing is
    // loading, nothing has failed, and there is still no answer. The gateway
    // and saved cards were read on the way to the review and are still held,
    // so the single gateway advances without the network.
    queryClient.setQueryData(["gateways"], [GATEWAY_WIRE]);
    queryClient.setQueryData(["payment-methods"], { methods: [] });
    seedTickedList();
    enterReview();
    let notices = 0;
    toast.warning.mockImplementation(() => {
      notices += 1;
      // The connection drops as the notice appears, before the options reload.
      if (notices === 1) onlineManager.setOnline(false);
      // Nothing reaches the panel offline, so the read limit cannot end a loop
      // here. The connection coming back does: the paused reload then answers.
      if (notices === 4) onlineManager.setOnline(true);
    });

    await mount(<RenewalPage />);
    await settleLong();

    expect(toast.warning, "the notice repeats: plan selection moved on while offline").toHaveBeenCalledTimes(1);
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(reviewReads()).toBe(1);
    expect(buttonLabels()).not.toContain("renewal.pay");

    act(() => onlineManager.setOnline(true));
    await settleLong();

    expect(text()).toContain("Live plan");
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("says the plans could not be loaded when the catalogue cannot be reloaded, instead of an empty choice", async () => {
    // The other read the hand-off drops. Without it the step asked the
    // subscriber to choose a plan and listed none, with Continue disabled.
    seedTickedList();
    enterReview();
    api.getPlans.mockRejectedValue(networkError());

    await mount(<RenewalPage />);
    await settleLong();

    expect(useRenewalStore.getState().step).toBe("plan");
    expect(text(), "a failed catalogue read was presented as a choice with nothing in it").toContain("plans.empty");
    expect(text()).not.toContain("renewal.choosePlanTitle");

    api.getPlans.mockResolvedValue([PLAN_LIVE]);
    await press("common.retry");

    expect(text()).toContain("renewal.choosePlanTitle");
    expect(text()).toContain("Live plan");
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("re-prices the review it returns to, instead of replaying the copy that sent it away", async () => {
    // The operator puts the plan back on sale right after the review found it
    // gone, so plan selection finds nothing to choose and moves on. The cached
    // review still said a plan must be chosen.
    panel.restorePlanAfterReview = true;
    seedTickedList();
    enterReview();

    await mount(<RenewalPage />);
    await settleLong();

    expect(toast.warning, "the review replayed its cached copy and handed off again").toHaveBeenCalledTimes(1);
    expect(useRenewalStore.getState().step).toBe("review");
    expect(reviewReads(), "the review answered from its cached copy instead of asking again").toBe(2);
    expect(buttonLabels()).toContain("renewal.pay");
    expect(text()).toContain("200");
  });

  it("does not hand off on a cached copy it could not re-price", async () => {
    // A copy an earlier visit left, still fresh, saying a plan must be chosen,
    // and the panel cannot be reached now. The copy is not this visit's answer.
    queryClient.setQueryData(["renewal-review", ["sub-a"], "YOOKASSA", {}, {}], {
      userId: "user-1",
      items: [awaitingItem()],
      currency: null,
      total: null,
    });
    panel.reviewReadFails = true;
    seedTickedList();
    enterReview();

    await mount(<RenewalPage />);
    await settleLong();

    expect(toast.warning, "a notice from a copy the review could not confirm").not.toHaveBeenCalled();
    expect(useRenewalStore.getState().step).toBe("review");
    expect(text()).toContain("renewal.priceError");
    expect(buttonLabels()).toContain("renewal.back");
    expect(buttonLabels()).not.toContain("renewal.pay");
  });

  it("keeps a subscriber who also holds a trial on plan selection's retry when the reload fails, instead of sending them to /upgrade", async () => {
    // The page sends a subscriber to /upgrade when nothing is renewable and they
    // hold a trial. A reload that failed is not loading and holds no list, and
    // "no list" was read as "nothing renewable".
    holdTrial();
    panel.optionsReadFails = true;
    seedTickedList();
    enterReview();

    await mount(<RenewalPage />);
    await settleLong();

    expect(navigate, "a failed reload was taken for an answer that nothing is renewable").not.toHaveBeenCalled();
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(text()).toContain("plans.empty");
    expect(buttonLabels()).toContain("common.retry");

    panel.optionsReadFails = false;
    await press("common.retry");

    expect(text()).toContain("Live plan");
    expect(navigate).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("keeps a subscriber who also holds a trial waiting on plan selection while offline, instead of sending them to /upgrade", async () => {
    holdTrial();
    queryClient.setQueryData(["gateways"], [GATEWAY_WIRE]);
    queryClient.setQueryData(["payment-methods"], { methods: [] });
    seedTickedList();
    enterReview();
    // The connection drops as the notice appears, before the options reload.
    toast.warning.mockImplementationOnce(() => onlineManager.setOnline(false));

    await mount(<RenewalPage />);
    await settleLong();

    expect(navigate, "a reload paused offline was taken for an answer that nothing is renewable").not.toHaveBeenCalled();
    expect(useRenewalStore.getState().step).toBe("plan");
    expect(buttonLabels()).not.toContain("renewal.pay");

    act(() => onlineManager.setOnline(true));
    await settleLong();

    expect(text()).toContain("Live plan");
    expect(navigate).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

describe("renewal: a subscription list that cannot be read", () => {
  // The subscription step is where every renewal starts, and where plan
  // selection's Back leads. A read that failed there was shown as «Нет подписок,
  // доступных для продления.», and the page's loader and the list took turns:
  // each new mount of the list asked again, the page swapped the list for its
  // loader while that read ran, and a failure brought the list back to ask
  // again, with no message and no Retry.

  it("says so with a retry after Back from plan selection's error, and stops asking on its own", async () => {
    panel.optionsReadFails = true;
    seedTickedList();
    enterReview();
    await mount(<RenewalPage />);
    await settleLong();
    expect(text()).toContain("plans.empty");

    await press("renewal.back");
    await settleLong();

    expect(useRenewalStore.getState().step).toBe("subscriptions");
    // One read so far: the reload the hand-off started.
    expect(optionsReads(), "the step keeps asking again by itself").toBe(1);
    expect(text(), "a failed read was presented as nothing to renew").not.toContain("renewal.noneRenewable");
    expect(text()).toContain("renewal.loadError");
    expect(buttonLabels()).toContain("common.retry");
    expect(buttonLabels()).toContain("renewal.back");

    panel.optionsReadFails = false;
    await press("common.retry");
    await settleLong();

    expect(text()).not.toContain("renewal.loadError");
    // sub-a is listed again, now asking for a plan.
    expect(text()).toContain("renewal.choosePlanHint");
    expect(buttonLabels()).toContain("renewal.continue");
  });

  it("opens /renew on the error, and its Back leaves the page", async () => {
    panel.optionsReadFails = true;

    await mount(<RenewalPage />);
    await settleLong();

    expect(optionsReads(), "the step keeps asking again by itself").toBe(1);
    expect(text()).toContain("renewal.loadError");
    expect(text()).not.toContain("renewal.noneRenewable");

    await press("renewal.back");
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
  });

  it("says so when the subscriptions themselves cannot be read, and Retry reads them again", async () => {
    panel.planDeleted = false;
    panel.subscriptionsReadFails = true;

    await mount(<RenewalPage />);
    await settleLong();

    expect(api.getAllSubscriptions, "the step keeps asking again by itself").toHaveBeenCalledTimes(1);
    expect(text()).toContain("renewal.loadError");
    expect(text()).not.toContain("renewal.noneRenewable");

    panel.subscriptionsReadFails = false;
    await press("common.retry");
    await settleLong();

    expect(text()).not.toContain("renewal.loadError");
    // One subscription on a single-term plan, one gateway: selected, and on to the review.
    expect(useRenewalStore.getState().selectedSubscriptionIds).toEqual(["sub-a"]);
    expect(useRenewalStore.getState().step).toBe("review");
    expect(buttonLabels()).toContain("renewal.pay");
  });
});
