// @vitest-environment jsdom
/**
 * The upgrade review's line about what the subscription keeps above the new
 * plan — «Сверх тарифа: +2 устройства, +10 ГБ — это сохранится и на новом
 * тарифе.»
 *
 * Rendered through the real review with the real Russian dictionary, so the
 * plural forms and the sentence are what a subscriber reads, not keys. The
 * three cases the owner named: a line when something carries, no line when
 * nothing does, and no line when the panel is older than the field (the
 * cabinet ships first).
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

import { describeCarriedAbovePlan } from "../src/features/upgrade/carried-above-plan";
import type { UpgradePlanOption } from "../src/lib/api-client/subscription";
import UpgradePage from "../src/features/upgrade/upgrade-page";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { useUpgradeStore } from "../src/stores/upgrade.store";

const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };
const FINITE_TARGET: UpgradePlanOption = {
  id: "plan-b",
  name: "Plan B",
  tag: null,
  type: "BOTH",
  trafficLimit: 500,
  deviceLimit: 5,
  durations: [{ id: "d-30", days: 30 }],
};

/** A priced upgrade quote as the BFF flattens it — and as an older panel still sends it. */
const PRICED = {
  planId: "plan-b",
  planName: "Plan B",
  durationDays: 30,
  currency: "RUB",
  basePrice: 300,
  finalPrice: 300,
  discountPercent: 0,
  gatewayType: "YOOKASSA",
};

const KEEPS_PREFIX = "Сверх тарифа:";

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

/** Mounts the page on its review step with `target` chosen, answering `quote`. */
async function review(quote: Record<string, unknown>, target: UpgradePlanOption = FINITE_TARGET): Promise<void> {
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
  expect(text()).toContain(ru.upgrade.reviewTitle);
  expect(text()).toContain(ru.upgrade.resetsExpiry);
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
  api.getUpgradeOptions.mockResolvedValue({ subscriptionId: "sub-1", plans: [FINITE_TARGET], warnings: [] });
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

describe("upgrade review: what the subscription keeps above the new plan", () => {
  it("names what carries, in one line beside the expiry note", async () => {
    await review({
      ...PRICED,
      carriedAbovePlan: { deviceLimit: 2, trafficLimitGb: 10, unlimitedDevices: false, unlimitedTraffic: false },
    });

    expect(text()).toContain("Сверх тарифа: +2 устройства, +10 ГБ — это сохранится и на новом тарифе.");
    expect(text().split(KEEPS_PREFIX)).toHaveLength(2);
  });

  it("shows no line when nothing carries", async () => {
    await review({
      ...PRICED,
      carriedAbovePlan: { deviceLimit: 0, trafficLimitGb: 0, unlimitedDevices: false, unlimitedTraffic: false },
    });

    expect(text()).not.toContain(KEEPS_PREFIX);
  });

  it("shows no line for a panel older than the field, and the review is otherwise whole", async () => {
    await review({ ...PRICED });

    expect(text()).not.toContain(KEEPS_PREFIX);
    expect(text()).toContain(ru.upgrade.pay);
  });

  it("leaves out a resource the new plan makes unlimited", async () => {
    await review(
      {
        ...PRICED,
        carriedAbovePlan: { deviceLimit: 2, trafficLimitGb: 10, unlimitedDevices: false, unlimitedTraffic: false },
      },
      { ...FINITE_TARGET, trafficLimit: null },
    );

    expect(text()).toContain("Сверх тарифа: +2 устройства — это сохранится и на новом тарифе.");
    expect(text()).not.toContain("ГБ —");
  });

  it("shows no line when the new plan is unlimited on everything that carries", async () => {
    await review(
      {
        ...PRICED,
        carriedAbovePlan: { deviceLimit: 2, trafficLimitGb: 10, unlimitedDevices: false, unlimitedTraffic: false },
      },
      { ...FINITE_TARGET, trafficLimit: null, deviceLimit: 0 },
    );

    expect(text()).not.toContain(KEEPS_PREFIX);
  });
});

describe("the line's wording", () => {
  const finite = { trafficLimit: 500, deviceLimit: 5 };

  it("agrees the Russian plural with the count", () => {
    const line = (devices: number) =>
      describeCarriedAbovePlan(
        { deviceLimit: devices, trafficLimitGb: 0, unlimitedDevices: false, unlimitedTraffic: false },
        finite,
        ruT,
      );
    expect(line(1)).toBe("Сверх тарифа: +1 устройство — это сохранится и на новом тарифе.");
    expect(line(3)).toBe("Сверх тарифа: +3 устройства — это сохранится и на новом тарифе.");
    expect(line(5)).toBe("Сверх тарифа: +5 устройств — это сохранится и на новом тарифе.");
  });

  it("says unlimited when an operator's unlimited setting stays on a finite plan", () => {
    expect(
      describeCarriedAbovePlan(
        { deviceLimit: 0, trafficLimitGb: 0, unlimitedDevices: true, unlimitedTraffic: true },
        finite,
        ruT,
      ),
    ).toBe("Сверх тарифа: безлимит устройств, безлимитный трафик — это сохранится и на новом тарифе.");
  });

  it("reads in English too", () => {
    expect(
      describeCarriedAbovePlan(
        { deviceLimit: 2, trafficLimitGb: 10, unlimitedDevices: false, unlimitedTraffic: false },
        finite,
        enT,
      ),
    ).toBe("Above your plan: +2 devices, +10 GB — you keep this on the new plan too.");
  });

  it("never says «докупленные»: the part above the plan is not always bought", () => {
    for (const value of [ru.upgrade.keepsAbovePlan, en.upgrade.keepsAbovePlan]) {
      expect(value.toLowerCase()).not.toMatch(/докуп|purchased|bought/);
    }
  });
});
