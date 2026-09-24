// @vitest-environment jsdom
/**
 * Until when an add-on works, where the customer decides and where they look
 * back: the add-on list and its confirmation («Действует до 12.10.26», or
 * «До конца подписки» when the subscription has no end), and «Мои опции».
 *
 * Rendered through the real pages with the real dictionaries. Nothing is said
 * for a traffic reset, which grants nothing that ends, nor when the panel
 * sends neither a date nor a lifetime to read one from — nor for a purchase
 * the panel does not say is dated (`eligibility.dated`): with stage 2 off it is
 * a permanent increment whatever date the offer carries, and a panel older
 * than the field says nothing.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next, { type TFunction } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  claimFreeTrafficReset: vi.fn(),
  getAddOnEntitlements: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getEnabledGateways: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
  purchaseAddOn: vi.fn(),
}));
const translate = vi.hoisted(() => ({
  t: ((key: string) => key) as (key: string, options?: Record<string, unknown>) => string,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => translate.t(key, options) }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, className }: { readonly children?: ReactNode; readonly className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
}));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ customIcons: [] }) }));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/subscription/subscription-select-card", () => ({
  SubscriptionSelectCard: () => null,
}));

import type { EligibleAddOn } from "../src/lib/api-client/content";
import type { UserAddOnEntitlement } from "../src/types/api";
import AddOnsPage from "../src/features/addons/addons-page";
import { describeAddOnEnd } from "../src/features/addons/add-on-end";
import MyAddOnsPage from "../src/features/settings/my-addons-page";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { formatDate, formatDateTime } from "../src/lib/utils";
import { useAddOnStore } from "../src/stores/addons.store";

const PERIOD_END = "2026-10-12T09:30:00.000Z";
const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };

function addOn(overrides: Partial<EligibleAddOn> & Pick<EligibleAddOn, "id" | "name" | "type">): EligibleAddOn {
  return {
    revision: 1,
    description: null,
    icon: null,
    value: 1,
    lifetime: "UNTIL_SUBSCRIPTION_END",
    eligibility: {
      eligible: true,
      activation: "NOW",
      expiresAt: PERIOD_END,
      dated: true,
      explanationCode: "ELIGIBLE_UNTIL_SUBSCRIPTION_END",
    },
    prices: [{ currency: "RUB", price: "99" }],
    ...overrides,
  };
}

const DATED = addOn({ id: "a-traffic", name: "Трафик плюс", type: "EXTRA_TRAFFIC", value: 50 });
const LIFETIME = addOn({
  id: "a-lifetime",
  name: "Устройство навсегда",
  type: "EXTRA_DEVICES",
  eligibility: {
    eligible: true,
    activation: "NOW",
    expiresAt: null,
    dated: true,
    explanationCode: "ELIGIBLE_UNTIL_SUBSCRIPTION_END",
  },
});
const RESET = addOn({
  id: "a-reset",
  name: "Сброс",
  type: "RESET_TRAFFIC",
  eligibility: { eligible: true, activation: "NOW", expiresAt: null, dated: false, explanationCode: "ELIGIBLE_RESET" },
  freeAllowance: null,
});
const UNKNOWN_END = addOn({
  id: "a-unknown",
  name: "Без срока",
  type: "EXTRA_DEVICES",
  value: 2,
  lifetime: "UNTIL_NEXT_RESET",
  eligibility: {
    eligible: true,
    activation: "NOW",
    expiresAt: null,
    dated: true,
    explanationCode: "ELIGIBLE_UNTIL_NEXT_RESET",
  },
});
/** Stage 2 off: the offer knows when the grant WOULD end, and the purchase never does. */
const PERMANENT = addOn({
  id: "a-permanent",
  name: "Навсегда плюс",
  type: "EXTRA_TRAFFIC",
  value: 20,
  eligibility: {
    eligible: true,
    activation: "NOW",
    expiresAt: PERIOD_END,
    dated: false,
    explanationCode: "ELIGIBLE_UNTIL_SUBSCRIPTION_END",
  },
});
/** A panel older than the field (0.9.7.68): a date, and nothing to say it is kept. */
const OLD_PANEL = addOn({
  id: "a-old-panel",
  name: "Старая панель",
  type: "EXTRA_DEVICES",
  value: 3,
  eligibility: {
    eligible: true,
    activation: "NOW",
    expiresAt: PERIOD_END,
    explanationCode: "ELIGIBLE_UNTIL_SUBSCRIPTION_END",
  },
});

let ruT: TFunction;
let enT: TFunction;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeAll(async () => {
  const ruInstance = i18next.createInstance();
  await ruInstance.init({ lng: "ru", resources: { ru: { translation: ru } }, interpolation: { escapeValue: false } });
  ruT = ruInstance.t.bind(ruInstance);
  const enInstance = i18next.createInstance();
  await enInstance.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  enT = enInstance.t.bind(enInstance);
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function mount(page: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>);
  });
}

function text(): string {
  return container?.textContent ?? "";
}

/** The text of the list card (a button) that names `name`. */
function card(name: string): string {
  const found = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes(name),
  );
  expect(found, `a card for ${name}`).toBeDefined();
  return found?.textContent ?? "";
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
  api.getSubscriptionAddOns.mockResolvedValue({
    contractVersion: 2,
    availability: "AVAILABLE",
    target: { subscriptionId: "sub-1", termId: "term-1", planId: "plan-a" },
    addOns: [DATED, LIFETIME, RESET, UNKNOWN_END, PERMANENT, OLD_PANEL],
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useAddOnStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the add-on list: until when each one works", () => {
  it("dates one that ends with the period, says «До конца подписки» with no end, nothing for a reset or with neither", async () => {
    mount(<AddOnsPage />);
    act(() => {
      useAddOnStore.setState({ step: "addon", selectedSubscriptionId: "sub-1" });
    });
    await settle();
    await settle();

    expect(card("Трафик плюс")).toContain(`Действует до ${formatDate(PERIOD_END)}`);
    expect(card("Устройство навсегда")).toContain("До конца подписки");
    expect(card("Устройство навсегда")).not.toContain("Действует до");
    expect(card("Сброс")).not.toContain("Действует до");
    expect(card("Сброс")).not.toContain("До конца подписки");
    expect(card("Без срока")).not.toContain("Действует до");
    expect(card("Без срока")).not.toContain("До конца подписки");
  });

  it("promises no end for a purchase the panel sells as permanent, nor from a panel that does not say", async () => {
    mount(<AddOnsPage />);
    act(() => {
      useAddOnStore.setState({ step: "addon", selectedSubscriptionId: "sub-1" });
    });
    await settle();
    await settle();

    for (const name of ["Навсегда плюс", "Старая панель"]) {
      expect(card(name)).not.toContain("Действует до");
      expect(card(name)).not.toContain(formatDate(PERIOD_END));
      expect(card(name)).not.toContain("До конца подписки");
    }
    // Non-vacuity: the dated neighbour on the same screen does carry its date.
    expect(card("Трафик плюс")).toContain(`Действует до ${formatDate(PERIOD_END)}`);
  });
});

describe("the confirmation: the last screen before the payment says it too", () => {
  async function confirmation(selected: EligibleAddOn): Promise<void> {
    mount(<AddOnsPage />);
    act(() => {
      useAddOnStore.setState({
        step: "review",
        selectedSubscriptionId: "sub-1",
        selectedAddOn: selected,
        selectedGateway: GATEWAY,
      });
    });
    await settle();
    expect(text()).toContain(ruT("addons.reviewTitle"));
  }

  it("dates an add-on that ends with the period", async () => {
    await confirmation(DATED);

    expect(text()).toContain(`Действует до ${formatDate(PERIOD_END)}`);
  });

  it("says «До конца подписки» for a subscription with no end", async () => {
    await confirmation(LIFETIME);

    expect(text()).toContain("До конца подписки");
  });

  it("says nothing for a traffic reset", async () => {
    await confirmation(RESET);

    expect(text()).not.toContain("Действует до");
    expect(text()).not.toContain("До конца подписки");
  });

  it("promises no end on the last screen for a permanent purchase, nor from a panel that does not say", async () => {
    for (const selected of [PERMANENT, OLD_PANEL]) {
      await confirmation(selected);

      expect(text()).not.toContain("Действует до");
      expect(text()).not.toContain(formatDate(PERIOD_END));
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    }
  });
});

describe("«Мои опции»: an add-on with no date", () => {
  function entitlement(
    overrides: Partial<UserAddOnEntitlement> & Pick<UserAddOnEntitlement, "id" | "receiptName">,
  ): UserAddOnEntitlement {
    return {
      subscriptionId: "sub-1",
      addOnId: null,
      type: "EXTRA_DEVICES",
      valuePerUnit: 1,
      quantity: 1,
      lifetime: "UNTIL_SUBSCRIPTION_END",
      state: "ACTIVE",
      currency: "RUB",
      totalAmount: "99",
      purchasedAt: "2026-09-01T09:30:00.000Z",
      activatedAt: "2026-09-01T09:30:00.000Z",
      expiresAt: null,
      ...overrides,
    };
  }

  /** The row that names `receiptName`. */
  function row(receiptName: string): string {
    const found = [...(container?.querySelectorAll("div.theme-surface") ?? [])].find((element) =>
      element.textContent?.includes(receiptName),
    );
    expect(found, `a row for ${receiptName}`).toBeDefined();
    return found?.textContent ?? "";
  }

  it("says «До конца подписки» for a live one bought until the end, and nothing once it has ended", async () => {
    api.getAddOnEntitlements.mockResolvedValue({
      entitlements: [
        entitlement({ id: "e-dated", receiptName: "Датированная", expiresAt: PERIOD_END }),
        entitlement({ id: "e-active", receiptName: "Бессрочной подписки" }),
        entitlement({ id: "e-pending", receiptName: "Ждёт начала", state: "PENDING_ACTIVATION", activatedAt: null }),
        entitlement({ id: "e-reversed", receiptName: "Возвращённая", state: "REVERSED" }),
        entitlement({ id: "e-reset", receiptName: "До сброса", lifetime: "UNTIL_NEXT_RESET" }),
      ],
    });
    mount(<MyAddOnsPage />);
    await settle();
    await settle();

    expect(row("Датированная")).toContain(`Действует до ${formatDateTime(PERIOD_END)}`);
    expect(row("Датированная")).not.toContain("До конца подписки");
    expect(row("Бессрочной подписки")).toContain("До конца подписки");
    expect(row("Ждёт начала")).toContain("До конца подписки");
    expect(row("Возвращённая")).not.toContain("До конца подписки");
    expect(row("До сброса")).not.toContain("До конца подписки");
  });
});

describe("the wording", () => {
  it("reads in English", () => {
    expect(describeAddOnEnd(DATED, enT)).toBe(`Valid until ${formatDate(PERIOD_END)}`);
    expect(describeAddOnEnd(LIFETIME, enT)).toBe("Until the subscription ends");
    expect(describeAddOnEnd(RESET, enT)).toBeNull();
  });

  it("says nothing for a panel that sends no eligibility at all", () => {
    expect(describeAddOnEnd({ type: "EXTRA_TRAFFIC", lifetime: "UNTIL_SUBSCRIPTION_END" }, ruT)).toBeNull();
    expect(
      describeAddOnEnd({ type: "EXTRA_TRAFFIC", lifetime: "UNTIL_SUBSCRIPTION_END", eligibility: null }, ruT),
    ).toBeNull();
  });

  it("says nothing unless the panel says the purchase is dated", () => {
    expect(describeAddOnEnd(PERMANENT, ruT)).toBeNull();
    expect(describeAddOnEnd(OLD_PANEL, ruT)).toBeNull();
    expect(describeAddOnEnd({ ...LIFETIME, eligibility: { ...LIFETIME.eligibility, dated: false } }, ruT)).toBeNull();
    expect(describeAddOnEnd(DATED, ruT)).toBe(`Действует до ${formatDate(PERIOD_END)}`);
  });
});
