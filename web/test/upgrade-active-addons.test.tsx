// @vitest-environment jsdom
/**
 * The upgrade review's line about the live add-ons the subscription keeps —
 * «Опции останутся: +2 устройства — до 12.10.26; +50 ГБ — до 01.11.26.» —
 * beside «Сверх тарифа» and the paid-remainder line, each told once.
 *
 * Rendered through the real review with the real dictionaries. Each add-on
 * keeps its own end, never later than the new end (owner, 24.09.2026); the
 * panel works the date out and takes those add-ons out of «Сверх тарифа».
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
import { describeActiveAddOns } from "../src/features/upgrade/active-add-ons";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { formatDate } from "../src/lib/utils";
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

const DEVICES_UNTIL = "2026-10-12T09:30:00.000Z";
const TRAFFIC_UNTIL = "2026-11-01T09:30:00.000Z";
const DEVICES = { type: "EXTRA_DEVICES" as const, value: 2, expiresAt: DEVICES_UNTIL };
const TRAFFIC = { type: "EXTRA_TRAFFIC" as const, value: 50, expiresAt: TRAFFIC_UNTIL };
const LINE_PREFIX = "Опции останутся:";

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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Mounts the page on its review step for `target`, answering `quote`. */
async function review(quote: Record<string, unknown>, target: UpgradePlanOption = TARGET): Promise<void> {
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
      selectedPlan: target,
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

describe("upgrade review: the live add-ons the subscription keeps", () => {
  it("names each one with the date it keeps", async () => {
    await review({ ...PRICED, activeAddOns: [DEVICES, TRAFFIC] });

    expect(text()).toContain(
      `Опции останутся: +2 устройства — до ${formatDate(DEVICES_UNTIL)}; +50 ГБ — до ${formatDate(TRAFFIC_UNTIL)}.`,
    );
    expect(occurrences(text(), LINE_PREFIX)).toBe(1);
  });

  it("says «до конца подписки» for one with no date: a new term with no end", async () => {
    await review({ ...PRICED, activeAddOns: [{ type: "EXTRA_DEVICES", value: 1, expiresAt: null }] });

    expect(text()).toContain("Опции останутся: +1 устройство — до конца подписки.");
  });

  it("adds no line with none to keep, and none from a panel older than the field", async () => {
    await review({ ...PRICED });

    expect(text()).not.toContain(LINE_PREFIX);
  });

  it("names nothing twice beside «Сверх тарифа» and the paid remainder: each amount in its own line", async () => {
    await review({
      ...PRICED,
      paidRemainderDays: 6,
      // The operator's +1 stays for good; the bought +2 until its date.
      carriedAbovePlan: { deviceLimit: 1, trafficLimitGb: 0, unlimitedDevices: false, unlimitedTraffic: false },
      activeAddOns: [DEVICES],
    });

    expect(text()).toContain("Сверх тарифа: +1 устройство — это сохранится и на новом тарифе.");
    expect(text()).toContain(`Опции останутся: +2 устройства — до ${formatDate(DEVICES_UNTIL)}.`);
    expect(text()).toContain("Оплаченный остаток прежнего тарифа: +6 дн.");
    expect(occurrences(text(), "+2 устройства")).toBe(1);
    expect(occurrences(text(), "+1 устройство")).toBe(1);
    expect(occurrences(text(), LINE_PREFIX)).toBe(1);
  });

  it("leaves out one the new plan makes meaningless: devices on a plan with unlimited devices", async () => {
    await review({ ...PRICED, activeAddOns: [DEVICES, TRAFFIC] }, { ...TARGET, deviceLimit: 0 });

    expect(text()).toContain(`Опции останутся: +50 ГБ — до ${formatDate(TRAFFIC_UNTIL)}.`);
    expect(text()).not.toContain("+2 устройства");
  });

  it("adds no line when every one is meaningless on the new plan", async () => {
    await review({ ...PRICED, activeAddOns: [TRAFFIC] }, { ...TARGET, trafficLimit: null });

    expect(text()).not.toContain(LINE_PREFIX);
  });
});

describe("the wording", () => {
  it("reads in English", () => {
    expect(describeActiveAddOns([DEVICES, { ...TRAFFIC, expiresAt: null }], TARGET, enT)).toBe(
      `Your add-ons stay: +2 devices until ${formatDate(DEVICES_UNTIL)}; +50 GB until the subscription ends.`,
    );
  });

  it("uses the Russian plural of the device count", () => {
    expect(describeActiveAddOns([{ ...DEVICES, value: 5 }], null, ruT)).toBe(
      `Опции останутся: +5 устройств — до ${formatDate(DEVICES_UNTIL)}.`,
    );
  });
});
