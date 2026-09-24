// @vitest-environment jsdom
/**
 * The upgrade review's line about the old plan's paid remainder — «Оплаченный
 * остаток прежнего тарифа: +8 дн. к сроку нового тарифа — точное число
 * посчитаем при оплате.» — and the expiry tip that has to stay true beside it.
 *
 * Rendered through the real review with the real dictionaries. The cases the
 * owner named: a line when days convert, the old tip word for word when none
 * do, and the old tip from a panel older than the field (the cabinet ships
 * first).
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next, { type TFunction } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createUpgradeCheckout: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getEnabledGateways: vi.fn(),
  getPlans: vi.fn(),
  getQuote: vi.fn(),
  getUpgradeOptions: vi.fn(),
}));
const translate = vi.hoisted(() => ({
  t: ((key: string) => key) as (key: string, options?: Record<string, unknown>) => string,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => translate.t(key, options) }),
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
  SubscriptionSelectCard: ({ onSelect }: { onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      subscription
    </button>
  ),
}));

import type { UpgradePlanOption } from "../src/lib/api-client/subscription";
import UpgradePage from "../src/features/upgrade/upgrade-page";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { useUpgradeStore } from "../src/stores/upgrade.store";

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
const TARGET: UpgradePlanOption = {
  id: "plan-b",
  name: "Премиум",
  tag: null,
  type: "BOTH",
  trafficLimit: 500,
  deviceLimit: 5,
  durations: [{ id: "d-30", days: 30 }],
};

/** A priced upgrade quote as the BFF flattens it — and as an older panel still sends it. */
const PRICED = {
  planId: "plan-b",
  planName: "Премиум",
  durationDays: 30,
  currency: "RUB",
  basePrice: 650,
  finalPrice: 650,
  discountPercent: 0,
  gatewayType: "YOOKASSA",
};

const OLD_TIP = "Улучшение начинается сразу и сбрасывает срок действия подписки.";
const NEW_TIP =
  "Улучшение начинается сразу: срок считается заново, а оплаченный остаток прежнего тарифа добавляется к нему днями.";
const LINE_PREFIX = "Оплаченный остаток прежнего тарифа";

let ruT: TFunction;
let enT: TFunction;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeAll(async () => {
  const ruInstance = i18next.createInstance();
  await ruInstance.init({
    lng: "ru",
    resources: { ru: { translation: ru } },
    interpolation: { escapeValue: false },
  });
  ruT = ruInstance.t.bind(ruInstance);
  const enInstance = i18next.createInstance();
  await enInstance.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  enT = enInstance.t.bind(enInstance);
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

/** Mounts the page on its review step, answering `quote`. */
async function review(quote: Record<string, unknown>): Promise<void> {
  api.getQuote.mockResolvedValue(quote);
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
  await settle();
  act(() => {
    useUpgradeStore.setState({
      step: "review",
      selectedSubscriptionId: "sub-1",
      selectedPlan: TARGET,
      selectedDurationDays: 30,
      selectedGateway: GATEWAY,
    });
  });
  await settle();
  await settle();
  // Not the error state: every case below is a priced review.
  expect(text()).toContain(ruT("upgrade.reviewTitle"));
  expect(text()).toContain(ruT("upgrade.pay"));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  translate.t = (key, options) => ruT(key, options);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
  api.getEnabledGateways.mockResolvedValue([]);
  api.getPlans.mockResolvedValue([]);
  api.getUpgradeOptions.mockResolvedValue({ subscriptionId: "sub-1", plans: [TARGET], warnings: [] });
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

describe("upgrade review: the old plan's paid remainder", () => {
  it("names the days, says they are counted at payment, and the tip no longer says the term is only reset", async () => {
    await review({ ...PRICED, paidRemainderDays: 8 });

    expect(text()).toContain(
      "Оплаченный остаток прежнего тарифа: +8 дн. к сроку нового тарифа — точное число посчитаем при оплате.",
    );
    expect(text().split(LINE_PREFIX)).toHaveLength(2);
    expect(text()).toContain(NEW_TIP);
    expect(text()).not.toContain(OLD_TIP);
  });

  it("keeps the old tip word for word and adds no line when nothing converts", async () => {
    await review({ ...PRICED, paidRemainderDays: 0 });

    expect(text()).toContain(OLD_TIP);
    expect(text()).not.toContain(LINE_PREFIX);
    expect(text()).not.toContain(NEW_TIP);
  });

  it("keeps the old tip word for word from a panel older than the field", async () => {
    await review({ ...PRICED });

    expect(text()).toContain(OLD_TIP);
    expect(text()).not.toContain(LINE_PREFIX);
  });

  it("shows the line beside what the subscription keeps above the plan", async () => {
    await review({
      ...PRICED,
      paidRemainderDays: 6,
      carriedAbovePlan: { deviceLimit: 2, trafficLimitGb: 0, unlimitedDevices: false, unlimitedTraffic: false },
    });

    expect(text()).toContain("+6 дн.");
    expect(text()).toContain("Сверх тарифа: +2 устройства — это сохранится и на новом тарифе.");
  });
});

describe("the wording", () => {
  it("the old tip is still the exact sentence an older panel's review shows", () => {
    expect(ruT("upgrade.resetsExpiry")).toBe(OLD_TIP);
  });

  it("reads in English, with no plural forms to get wrong", () => {
    expect(enT("upgrade.paidRemainder", { days: 1 })).toBe(
      "Paid remainder of your current plan: +1 d on top of the new term — the exact number is counted at payment.",
    );
    expect(enT("upgrade.resetsExpiryWithRemainder")).toBe(
      "The upgrade starts immediately: the term starts over, and the paid remainder of your current plan is added to it as days.",
    );
    expect(ruT("upgrade.paidRemainder", { days: 1 })).toContain("+1 дн.");
  });
});
