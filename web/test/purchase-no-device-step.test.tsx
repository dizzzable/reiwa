// @vitest-environment jsdom

/**
 * The purchase wizard asks no device.
 *
 * It used to ask «На каком устройстве?» (iPhone, Android, Windows, macOS)
 * between «Выберите срок» and «Способ оплаты», showed the answer as
 * «Устройство» on «Подтвердите оплату», and sent it to the panel as
 * `deviceType` with either way to pay. Nothing ever read it, and the question
 * made buyers think a subscription is tied to one device. So the term now leads
 * straight to the payment method, «Назад» there returns to the term, the quote
 * names no device, and neither payment carries one.
 *
 * The real wizard and store, entered the way the plans page and the dashboard's
 * trial offer enter it (`selectPlan`). The api is mocked at the client module;
 * what the client puts on the wire is pinned apart, in
 * `checkout-request-no-device-type.test.ts`. `motion/react` is mocked: these
 * cases are about which step comes next, not how it animates in.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  createUpgradeCheckout: vi.fn(),
  getActionPolicy: vi.fn(),
  // No trial here, so the purchase creates a subscription (`lib/trial-conversion`).
  getAllSubscriptions: vi.fn(),
  getQuote: vi.fn(),
  getEnabledGateways: vi.fn(),
  getPaymentMethods: vi.fn(),
  activatePromocode: vi.fn(),
  getPartnerInfo: vi.fn(),
  payWithPartnerBalance: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  // The values ride along, so the two terms' buttons read apart.
  useTranslation: () => ({
    t: (key: string, values?: unknown) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`),
    i18n: { language: "ru" },
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
}));

import PurchasePage from "../src/features/purchase/purchase-page";
import { usePurchaseStore } from "../src/stores/purchase.store";

const PAY = "purchase.quote.pay";
const PAY_WITH_BALANCE = "purchase.quote.payWithBalance";
const DURATION_TITLE = "purchase.duration.title";
const GATEWAY_TITLE = "purchase.gateway.title";
const QUOTE_TITLE = "purchase.quote.title";

/** Plan P with two terms, so the term step waits for the buyer's choice. */
const PLAN = {
  id: "plan-p",
  name: "Plan P",
  type: "BOTH",
  isTrial: false,
  durations: [
    { id: "d-30", days: 30, prices: [{ currency: "RUB", price: "200", gatewayType: "YOOKASSA" }] },
    { id: "d-90", days: 90, prices: [{ currency: "RUB", price: "500", gatewayType: "YOOKASSA" }] },
  ],
};
/** A plan with one term, which the term step picks by itself on the way in. */
const SINGLE_TERM_PLAN = { ...PLAN, durations: [PLAN.durations[0]!] };

/** Two gateways, so the payment-method step waits for the buyer's choice. */
const GATEWAYS_WIRE = [
  { type: "YOOKASSA", displayName: "YooKassa", currency: "RUB", isActive: true },
  { type: "CRYPTOMUS", displayName: "Cryptomus", currency: "USD", isActive: true },
];

/** Plan P for 30 days through YooKassa, 200 RUB as the panel prices it. */
const PRICED = {
  planId: "plan-p",
  planName: "Plan P",
  durationDays: 30,
  currency: "RUB",
  basePrice: 200,
  finalPrice: 200,
  discountPercent: 0,
  gatewayType: "YOOKASSA",
};

/** A partner allowed to pay with a balance (in kopecks) that covers those 200 RUB. */
const PARTNER = {
  id: "partner-1",
  isActive: true,
  balance: 50_000,
  totalEarned: 50_000,
  totalWithdrawn: 0,
  programAvailable: true,
  balancePaymentEnabled: true,
  balanceCurrency: "RUB",
  createdAt: "2026-09-01T00:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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

function text(): string {
  return container?.textContent ?? "";
}

/** The heading of the step on screen (the page's own <h1> is the plan's name); "" while none is. */
function stepHeading(): string {
  return [...(container?.querySelectorAll("h2") ?? [])].map((heading) => heading.textContent ?? "").join(" | ");
}

function step(): string {
  return usePurchaseStore.getState().step;
}

function buttonWhere(matches: (label: string) => boolean, what: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find((candidate) =>
    matches(candidate.textContent?.trim() ?? ""),
  );
  if (!found) throw new Error(`no ${what} button on screen; it shows: ${text()}`);
  return found;
}

async function tap(target: HTMLButtonElement): Promise<void> {
  act(() => target.click());
  await settle();
}

/** The term's row on «Выберите срок». */
function termButton(days: number): HTMLButtonElement {
  return buttonWhere((label) => label.includes(`purchase.duration.days:{"count":${days}}`), `${days}-day term`);
}

/** The header's back arrow — the only «Назад» the payment-method step has. */
function backButton(): HTMLButtonElement {
  const found = container?.querySelector<HTMLButtonElement>('button[aria-label="purchase.back"]');
  if (!found) throw new Error(`no back button on screen; it shows: ${text()}`);
  return found;
}

/** The segments of the progress bar under the header, one per step. */
function progressSegments(): number {
  return container?.querySelectorAll("div.flex-1.rounded-full").length ?? 0;
}

/** The label of every row on «Подтвердите оплату», top to bottom, the total included. */
function quoteRowLabels(): string[] {
  const card = [...(container?.querySelectorAll(".glass-card") ?? [])].find((candidate) =>
    candidate.textContent?.includes("purchase.quote.plan"),
  );
  if (!card) throw new Error(`no quote on screen; it shows: ${text()}`);
  return [...card.children].map((row) => row.querySelector("span")?.textContent?.trim() ?? "");
}

/** Opens the wizard on `plan` as the plans page does. */
function mountWizard(plan: typeof PLAN): void {
  usePurchaseStore.getState().selectPlan(plan as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <PurchasePage />
      </QueryClientProvider>,
    );
  });
}

/** Opens the wizard on a plan with several terms, and waits for «Выберите срок». */
async function openWizard(plan: typeof PLAN): Promise<void> {
  mountWizard(plan);
  await waitUntil(() => stepHeading() !== "");
}

/** From «Выберите срок»: 30 days, then YooKassa, and waits for the priced quote. */
async function reachQuote(): Promise<void> {
  await tap(termButton(30));
  await waitUntil(() => stepHeading() !== "");
  expect(stepHeading()).toBe(GATEWAY_TITLE);
  await tap(buttonWhere((label) => label.includes("YooKassa"), "YooKassa"));
  // A spinner, and no heading, until the quote is priced.
  await waitUntil(() => stepHeading() !== "");
  expect(stepHeading()).toBe(QUOTE_TITLE);
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
  api.getActionPolicy.mockResolvedValue({
    canBuy: true,
    canRenew: true,
    canUpgrade: true,
    canTrial: false,
    activeSubscriptionCount: 0,
  });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
  api.getEnabledGateways.mockResolvedValue(GATEWAYS_WIRE);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getQuote.mockResolvedValue(PRICED);
  api.getPartnerInfo.mockResolvedValue(PARTNER);
  api.createCheckout.mockResolvedValue({ paymentId: "pay-new", checkoutUrl: null });
  api.payWithPartnerBalance.mockResolvedValue({
    paymentId: "balance-1",
    transactionStatus: "COMPLETED",
    amount: "200",
    currency: "RUB",
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  usePurchaseStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the purchase wizard asks no device", () => {
  it("goes from the term straight to the payment method", async () => {
    await openWizard(PLAN);
    expect(stepHeading()).toBe(DURATION_TITLE);
    // Term, payment method, quote, checkout: one segment each, none for a device.
    expect(progressSegments(), "the progress bar still counts a device step").toBe(4);

    await tap(termButton(30));

    expect(step(), "the term led somewhere other than the payment method").toBe("gateway");
    expect(usePurchaseStore.getState().selectedDuration?.days).toBe(30);
    await waitUntil(() => stepHeading() !== "");
    expect(stepHeading()).toBe(GATEWAY_TITLE);
    expect(text()).toContain("YooKassa");
  });

  it("«Назад» on the payment method returns to the term", async () => {
    await openWizard(PLAN);
    await tap(termButton(30));
    await waitUntil(() => stepHeading() !== "");
    expect(stepHeading()).toBe(GATEWAY_TITLE);

    await tap(backButton());

    expect(step(), "«Назад» from the payment method did not land on the term").toBe("duration");
    expect(stepHeading()).toBe(DURATION_TITLE);
    expect(usePurchaseStore.getState().selectedGateway).toBeNull();
    expect(navigate, "«Назад» left the wizard instead of stepping back").not.toHaveBeenCalled();
  });

  it("«Назад» returns a single-term plan to its term, and it stays there", async () => {
    // The term step picks the only term by itself on the way in — and must not
    // on the way back, or «Назад» bounces straight to the payment method again.
    mountWizard(SINGLE_TERM_PLAN);
    await waitUntil(() => step() !== "duration");
    expect(step()).toBe("gateway");
    await waitUntil(() => stepHeading() !== "");
    expect(stepHeading()).toBe(GATEWAY_TITLE);

    await tap(backButton());
    await settle();
    await settle();

    expect(step(), "«Назад» bounced back to the payment method").toBe("duration");
    expect(stepHeading()).toBe(DURATION_TITLE);
  });

  it("opens a plan with one term and one payment method on the quote", async () => {
    // Both steps pick their only option on the way in. The device step used to
    // stop the buyer between them; now «Подтвердите оплату» comes first, and
    // nothing is paid until «Перейти к оплате».
    api.getEnabledGateways.mockResolvedValue([GATEWAYS_WIRE[0]]);

    mountWizard(SINGLE_TERM_PLAN);
    await waitUntil(() => step() !== "duration" && step() !== "gateway");

    expect(step(), "the wizard stopped between the term and the payment method").toBe("quote");
    await waitUntil(() => stepHeading() !== "");
    expect(stepHeading()).toBe(QUOTE_TITLE);
    expect(api.createCheckout).not.toHaveBeenCalled();
    expect(api.payWithPartnerBalance).not.toHaveBeenCalled();
  });

  it("names no device on «Подтвердите оплату»", async () => {
    await openWizard(PLAN);
    await reachQuote();

    // Every row, so a device row anywhere among them — or any other — fails.
    expect(quoteRowLabels()).toEqual([
      "purchase.quote.plan",
      "purchase.quote.duration",
      "purchase.quote.method",
      "purchase.quote.total",
    ]);
  });

  it("pays through the gateway without a device", async () => {
    await openWizard(PLAN);
    await reachQuote();

    await tap(buttonWhere((label) => label === PAY, "Pay"));
    await waitUntil(() => api.createCheckout.mock.calls.length > 0);

    // Plan, term, gateway, no saved card, no card to save, no consent, NEW —
    // and nothing after the gateway where the device used to go.
    expect(api.createCheckout.mock.calls).toEqual([["plan-p", 30, "YOOKASSA", null, false, false, "NEW"]]);
    expect(api.payWithPartnerBalance).not.toHaveBeenCalled();
  });

  it("pays from the partner balance without a device", async () => {
    await openWizard(PLAN);
    await reachQuote();

    await tap(buttonWhere((label) => label.startsWith(`${PAY_WITH_BALANCE}:`), "balance"));
    await waitUntil(() => navigate.mock.calls.length > 0);

    expect(api.payWithPartnerBalance).toHaveBeenCalledTimes(1);
    // `toEqual` skips a field left undefined, as the wire does; any other field fails it.
    expect(api.payWithPartnerBalance.mock.calls[0]![0]).toEqual({
      purchaseType: "NEW",
      planId: "plan-p",
      durationDays: 30,
    });
    expect(api.createCheckout).not.toHaveBeenCalled();
  });
});
