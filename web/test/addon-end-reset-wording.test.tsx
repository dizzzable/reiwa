// @vitest-environment jsdom
/**
 * Stage 4: a traffic add-on lasts until Remnawave's own traffic reset, and the
 * cabinet says so (P9, the owner's decisions of 24.09.2026).
 *
 *   - The list and the confirmation. The reset bound reads «Действует до
 *     сброса трафика 01.10 в 03:20 (по Москве) — через 7 дн.»: the RESET
 *     instant, not the take-off half an hour later, on the operator's clock,
 *     zone named, days counted on that clock's calendar. The subscription-end
 *     bound reads «Действует до конца подписки 30.09» — also for a reset add-on
 *     the subscription's end cuts short, although the panel still sends the
 *     reset it would have ended at.
 *   - Before the payment, when the panel says the reset is less than a day
 *     away: «Сброс трафика через 5 ч — после него опция закончится».
 *   - «Мои опции» in the same forms; «через …» only for an add-on that works.
 *   - A panel that predates the fields keeps today's wording (the cabinet
 *     ships first) — pinned in full by `addon-end-date.test.tsx`.
 *
 * Rendered through the real pages with the real dictionaries and the real
 * `Intl`; only the network and the clock are replaced. The clock stands at
 * 24.09.2026 22:00 by Moscow, 19:00 UTC.
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
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate.t(key, options),
    i18n: { language: "ru" },
  }),
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

import type { AddOnEligibilityResult, EligibleAddOn } from "../src/lib/api-client/content";
import type { UserAddOnEntitlement } from "../src/types/api";
import AddOnsPage from "../src/features/addons/addons-page";
import {
  describeAddOnEnd,
  describeEntitlementEnd,
  describeResetSoon,
} from "../src/features/addons/add-on-end";
import MyAddOnsPage from "../src/features/settings/my-addons-page";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { countdown } from "../src/lib/operator-zone";
import { formatDate, formatDateTime } from "../src/lib/utils";
import { useAddOnStore } from "../src/stores/addons.store";

/** 24.09.2026, 22:00 by Moscow — 19:00 UTC. Every page here renders at this moment. */
const NOW = new Date("2026-09-24T19:00:00.000Z");
/** Remnawave's MONTH reset, the 1st at 00:20 on a UTC scheduler: 01.10 03:20 by Moscow. */
const MONTH_RESET = "2026-10-01T00:20:00.000Z";
/** Half an hour after it, when the panel takes the add-on off: never the time shown. */
const MONTH_TAKE_OFF = "2026-10-01T00:50:00.000Z";
/** Remnawave's DAY reset, 00:05 UTC: 25.09 03:05 by Moscow, 5 h 05 min from NOW. */
const DAY_RESET = "2026-09-25T00:05:00.000Z";
const DAY_TAKE_OFF = "2026-09-25T00:35:00.000Z";
/** A subscription that ends before the reset: 30.09 00:30 by Moscow, still 29.09 in UTC. */
const SUBSCRIPTION_END = "2026-09-29T21:30:00.000Z";
const MOSCOW = "Europe/Moscow";
const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };

function addOn(
  overrides: Partial<Omit<EligibleAddOn, "eligibility">> & Pick<EligibleAddOn, "id" | "name">,
  eligibility: Partial<EligibleAddOn["eligibility"]>,
): EligibleAddOn {
  return {
    revision: 1,
    description: null,
    type: "EXTRA_TRAFFIC",
    icon: null,
    value: 50,
    lifetime: "UNTIL_NEXT_RESET",
    prices: [{ currency: "RUB", price: "149" }],
    ...overrides,
    eligibility: {
      eligible: true,
      activation: "NOW",
      expiresAt: MONTH_TAKE_OFF,
      dated: true,
      explanationCode: "ELIGIBLE_UNTIL_NEXT_RESET",
      ...eligibility,
    },
  };
}

/** Ends at the MONTH reset a week away. */
const UNTIL_RESET = addOn(
  { id: "a-reset", name: "Трафик до сброса" },
  { endsBound: "reset", nextResetAt: MONTH_RESET, resetSoon: false },
);
/** Ends at the DAY reset five hours away, and the panel says so. */
const RESET_SOON = addOn(
  { id: "a-soon", name: "Трафик на вечер" },
  { expiresAt: DAY_TAKE_OFF, endsBound: "reset", nextResetAt: DAY_RESET, resetSoon: true },
);
/** Sold until the reset, but the subscription ends first — and the panel still sends the reset. */
const CAPPED = addOn(
  { id: "a-capped", name: "Трафик до конца" },
  {
    expiresAt: SUBSCRIPTION_END,
    endsBound: "subscription_end",
    nextResetAt: MONTH_RESET,
    resetSoon: false,
    explanationCode: "ELIGIBLE_UNTIL_SUBSCRIPTION_END_BEFORE_RESET",
  },
);
/**
 * An older panel: the same kind of add-on, the reset five hours away, and not a
 * word about the bound or how near the reset is.
 */
const OLD_PANEL = addOn({ id: "a-old", name: "Старая панель" }, { expiresAt: DAY_TAKE_OFF });

function offer(addOns: EligibleAddOn[], displayTimeZone?: string | null): AddOnEligibilityResult {
  return {
    contractVersion: 2,
    availability: "AVAILABLE",
    target: { subscriptionId: "sub-1", termId: "term-1", planId: "plan-a" },
    addOns,
    ...(displayTimeZone === undefined ? {} : { displayTimeZone }),
  };
}

function entitlement(
  overrides: Partial<UserAddOnEntitlement> & Pick<UserAddOnEntitlement, "id" | "receiptName">,
): UserAddOnEntitlement {
  return {
    subscriptionId: "sub-1",
    addOnId: "a-reset",
    type: "EXTRA_TRAFFIC",
    valuePerUnit: 50,
    quantity: 1,
    lifetime: "UNTIL_NEXT_RESET",
    state: "ACTIVE",
    currency: "RUB",
    totalAmount: "149",
    purchasedAt: "2026-09-20T09:30:00.000Z",
    activatedAt: "2026-09-20T09:30:00.000Z",
    expiresAt: MONTH_TAKE_OFF,
    ...overrides,
  };
}

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

function unmount(): void {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
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

/** The «Мои опции» row that names `receiptName`. */
function row(receiptName: string): string {
  const found = [...(container?.querySelectorAll("div.theme-surface") ?? [])].find((element) =>
    element.textContent?.includes(receiptName),
  );
  expect(found, `a row for ${receiptName}`).toBeDefined();
  return found?.textContent ?? "";
}

/** The warning above «Перейти к оплате», or `null` when there is none. */
function warning(): string | null {
  return container?.querySelector('[data-testid="addon-reset-soon-warning"]')?.textContent ?? null;
}

async function openList(): Promise<void> {
  mount(<AddOnsPage />);
  act(() => {
    useAddOnStore.setState({ step: "addon", selectedSubscriptionId: "sub-1" });
  });
  await settle();
  await settle();
}

async function openConfirmation(selected: EligibleAddOn): Promise<void> {
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
  await settle();
  // The confirmation itself is on screen — whatever is or is not said below.
  expect(text()).toContain(ruT("addons.reviewTitle"));
}

beforeEach(() => {
  // Only the clock: timers stay real, so React and the query client run as in the app.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  translate.t = (key, options) => ruT(key, options);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
  api.getEnabledGateways.mockResolvedValue([]);
});

afterEach(() => {
  unmount();
  useAddOnStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the add-on list", () => {
  it("dates a reset add-on at the reset itself, on the operator's clock, zone named, with the days left", async () => {
    api.getSubscriptionAddOns.mockResolvedValue(offer([UNTIL_RESET, CAPPED, OLD_PANEL], MOSCOW));
    await openList();

    expect(card("Трафик до сброса")).toContain(
      "Действует до сброса трафика 01.10 в 03:20 (по Москве) — через 7 дн.",
    );
    // Not the take-off half an hour later: the gigabytes go at the reset.
    expect(card("Трафик до сброса")).not.toContain("03:50");
  });

  it("dates one the subscription's end cuts short by that end, not by the reset the panel still sends", async () => {
    api.getSubscriptionAddOns.mockResolvedValue(offer([UNTIL_RESET, CAPPED, OLD_PANEL], MOSCOW));
    await openList();

    expect(card("Трафик до конца")).toContain("Действует до конца подписки 30.09");
    expect(card("Трафик до конца")).not.toContain("сброса");
    expect(card("Трафик до конца")).not.toContain("01.10");
  });

  it("keeps today's wording for an add-on from a panel that names no bound", async () => {
    api.getSubscriptionAddOns.mockResolvedValue(offer([UNTIL_RESET, CAPPED, OLD_PANEL]));
    await openList();

    expect(card("Старая панель")).toContain(`Действует до ${formatDate(DAY_TAKE_OFF)}`);
    expect(card("Старая панель")).not.toContain("сброса");
    expect(card("Старая панель")).not.toContain("конца подписки");
  });
});

describe("the confirmation, before the payment", () => {
  it("warns when the reset that ends the add-on is less than a day away", async () => {
    api.getSubscriptionAddOns.mockResolvedValue(offer([RESET_SOON], MOSCOW));
    await openConfirmation(RESET_SOON);

    expect(warning()).toBe("Сброс трафика через 5 ч — после него опция закончится");
    expect(text()).toContain("Действует до сброса трафика 25.09 в 03:05 (по Москве) — через 5 ч");
  });

  it("does not warn when the panel does not say the reset is near: a week off, cut short, or an older panel", async () => {
    const cases: ReadonlyArray<readonly [EligibleAddOn, string | undefined, string]> = [
      [UNTIL_RESET, MOSCOW, "Действует до сброса трафика 01.10 в 03:20 (по Москве) — через 7 дн."],
      [CAPPED, MOSCOW, "Действует до конца подписки 30.09"],
      [OLD_PANEL, undefined, `Действует до ${formatDate(DAY_TAKE_OFF)}`],
    ];
    for (const [selected, zone, endLine] of cases) {
      api.getSubscriptionAddOns.mockResolvedValue(offer([selected], zone));
      await openConfirmation(selected);

      expect(warning(), selected.name).toBeNull();
      // Non-vacuity: the same screen does say when the add-on ends.
      expect(text(), selected.name).toContain(endLine);
      unmount();
      queryClient.clear();
    }
  });
});

describe("«Мои опции»", () => {
  it("dates each add-on by the bound that ends it, and counts down only while it works", async () => {
    api.getAddOnEntitlements.mockResolvedValue({
      entitlements: [
        entitlement({ id: "e-reset", receiptName: "До сброса", endsBound: "reset", resetAt: MONTH_RESET }),
        entitlement({
          id: "e-capped",
          receiptName: "До конца",
          expiresAt: SUBSCRIPTION_END,
          endsBound: "subscription_end",
          resetAt: null,
        }),
        entitlement({
          id: "e-refunded",
          receiptName: "Возвращённая",
          state: "REVERSED",
          endsBound: "reset",
          resetAt: MONTH_RESET,
        }),
      ],
      displayTimeZone: MOSCOW,
    });
    mount(<MyAddOnsPage />);
    await settle();
    await settle();

    expect(row("До сброса")).toContain("Действует до сброса трафика 01.10 в 03:20 (по Москве) — через 7 дн.");
    expect(row("До сброса")).not.toContain("03:50");
    expect(row("До конца")).toContain("Действует до конца подписки 30.09");
    expect(row("До конца")).not.toContain("сброса");
    // A refunded add-on has no days left to count, though its reset is ahead.
    expect(row("Возвращённая")).toContain("Действует до сброса трафика 01.10 в 03:20 (по Москве)");
    expect(row("Возвращённая")).not.toContain("через");
  });

  it("keeps today's wording from a panel that does not say which bound ends an add-on", async () => {
    api.getAddOnEntitlements.mockResolvedValue({
      entitlements: [
        entitlement({ id: "e-old", receiptName: "Старая панель" }),
        entitlement({
          id: "e-old-open",
          receiptName: "Без даты",
          lifetime: "UNTIL_SUBSCRIPTION_END",
          expiresAt: null,
        }),
      ],
    });
    mount(<MyAddOnsPage />);
    await settle();
    await settle();

    expect(row("Старая панель")).toContain(`Действует до ${formatDateTime(MONTH_TAKE_OFF)}`);
    expect(row("Старая панель")).not.toContain("сброса");
    expect(row("Без даты")).toContain("До конца подписки");
  });
});

describe("the wording", () => {
  const ON_MOSCOW = { displayTimeZone: MOSCOW, language: "ru", now: NOW };

  it("reads the time in the operator's zone and names it; no zone, or one this browser does not know, is UTC", () => {
    expect(describeAddOnEnd(UNTIL_RESET, ruT, ON_MOSCOW)).toBe(
      "Действует до сброса трафика 01.10 в 03:20 (по Москве) — через 7 дн.",
    );
    for (const zone of [null, undefined, "", "Mars/Olympus_Mons"]) {
      expect(describeAddOnEnd(UNTIL_RESET, ruT, { displayTimeZone: zone, language: "ru", now: NOW }), String(zone)).toBe(
        "Действует до сброса трафика 01.10 в 00:20 (по UTC) — через 7 дн.",
      );
    }
    // Already 25.09 there at NOW (00:00 in Yekaterinburg), so the days are counted from it.
    expect(describeAddOnEnd(UNTIL_RESET, ruT, { displayTimeZone: "Asia/Yekaterinburg", language: "ru", now: NOW })).toBe(
      "Действует до сброса трафика 01.10 в 05:20 (по Екатеринбургу) — через 6 дн.",
    );
    // A zone with no Russian name goes by its offset.
    expect(describeAddOnEnd(UNTIL_RESET, ruT, { displayTimeZone: "Asia/Kolkata", language: "ru", now: NOW })).toBe(
      "Действует до сброса трафика 01.10 в 05:50 (UTC+5:30) — через 6 дн.",
    );
    // The date of the subscription's end is the operator's date too: 30.09 by Moscow is 29.09 in UTC.
    expect(describeAddOnEnd(CAPPED, ruT, ON_MOSCOW)).toBe("Действует до конца подписки 30.09");
    expect(describeAddOnEnd(CAPPED, ruT, { displayTimeZone: null, language: "ru", now: NOW })).toBe(
      "Действует до конца подписки 29.09",
    );
  });

  it("reads in English", () => {
    const context = { displayTimeZone: MOSCOW, language: "en", now: NOW };
    expect(describeAddOnEnd(UNTIL_RESET, enT, context)).toBe(
      "Valid until the traffic reset on Oct 1 at 03:20 (Moscow Time) — in 7 days",
    );
    expect(describeAddOnEnd(CAPPED, enT, context)).toBe("Valid until the subscription ends on Sep 30");
    expect(describeResetSoon(RESET_SOON, enT, context)).toBe("The traffic resets in 5 hours — the add-on ends with it");
    expect(describeAddOnEnd(UNTIL_RESET, enT, { ...context, displayTimeZone: null })).toBe(
      "Valid until the traffic reset on Oct 1 at 00:20 (UTC) — in 7 days",
    );
  });

  it("still names the zone in a browser without the newer Intl zone names (Safari before 15.4)", () => {
    // `timeZoneName: "longOffset"` / `"shortGeneric"` throw a RangeError there —
    // and this runs during a render, where a throw takes the whole cabinet down.
    const RealDateTimeFormat = Intl.DateTimeFormat;
    class OlderDateTimeFormat extends RealDateTimeFormat {
      constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
        if (options?.timeZoneName === "longOffset" || options?.timeZoneName === "shortGeneric") {
          throw new RangeError(`timeZoneName must be "short" or "long", got ${options.timeZoneName}`);
        }
        super(locales, options);
      }
    }
    vi.stubGlobal("Intl", Object.create(Intl, { DateTimeFormat: { value: OlderDateTimeFormat } }));

    expect(describeAddOnEnd(UNTIL_RESET, ruT, ON_MOSCOW)).toBe(
      "Действует до сброса трафика 01.10 в 03:20 (по Москве) — через 7 дн.",
    );
    // English has no name to give without `shortGeneric`: the offset names it.
    expect(describeAddOnEnd(UNTIL_RESET, enT, { ...ON_MOSCOW, language: "en" })).toBe(
      "Valid until the traffic reset on Oct 1 at 03:20 (UTC+3) — in 7 days",
    );
    expect(describeAddOnEnd(UNTIL_RESET, ruT, { ...ON_MOSCOW, displayTimeZone: "Asia/Kolkata" })).toBe(
      "Действует до сброса трафика 01.10 в 05:50 (UTC+5:30) — через 6 дн.",
    );
    // West of UTC, and in its summer time: New York is UTC-4 in September.
    expect(describeAddOnEnd(UNTIL_RESET, ruT, { ...ON_MOSCOW, displayTimeZone: "America/New_York" })).toBe(
      "Действует до сброса трафика 30.09 в 20:20 (UTC-4) — через 6 дн.",
    );
  });

  it("names the year of an end that is not this year's", () => {
    const yearly = addOn(
      { id: "a-yearly", name: "На год" },
      {
        expiresAt: "2027-09-20T09:00:00.000Z",
        endsBound: "subscription_end",
        nextResetAt: null,
        resetSoon: false,
        explanationCode: "ELIGIBLE_UNTIL_SUBSCRIPTION_END",
      },
    );
    expect(describeAddOnEnd(yearly, ruT, ON_MOSCOW)).toBe("Действует до конца подписки 20.09.27");
    expect(describeAddOnEnd(yearly, enT, { ...ON_MOSCOW, language: "en" })).toBe(
      "Valid until the subscription ends on Sep 20, 2027",
    );
  });

  it("warns only when the panel says the reset is near, and not once that reset has passed", () => {
    expect(describeResetSoon(RESET_SOON, ruT, ON_MOSCOW)).toBe("Сброс трафика через 5 ч — после него опция закончится");
    expect(describeResetSoon(UNTIL_RESET, ruT, ON_MOSCOW)).toBeNull();
    expect(describeResetSoon(CAPPED, ruT, ON_MOSCOW)).toBeNull();
    expect(describeResetSoon(OLD_PANEL, ruT, ON_MOSCOW)).toBeNull();
    // A purchase the panel does not date is not ended by any reset.
    expect(
      describeResetSoon({ ...RESET_SOON, eligibility: { ...RESET_SOON.eligibility, dated: false } }, ruT, ON_MOSCOW),
    ).toBeNull();
    // The reset came and went while the offer sat on the screen: a purchase now
    // belongs to the next cycle, which the panel quotes afresh.
    const afterReset = new Date("2026-09-25T00:06:00.000Z");
    expect(describeResetSoon(RESET_SOON, ruT, { ...ON_MOSCOW, now: afterReset })).toBeNull();
    expect(describeAddOnEnd(RESET_SOON, ruT, { ...ON_MOSCOW, now: afterReset })).toBe(
      "Действует до сброса трафика 25.09 в 03:05 (по Москве)",
    );
  });

  it("falls back to today's wording when the reset bound comes without its reset", () => {
    const noReset = addOn(
      { id: "a-no-reset", name: "Без сброса" },
      { endsBound: "reset", nextResetAt: null, resetSoon: false },
    );
    expect(describeAddOnEnd(noReset, ruT, ON_MOSCOW)).toBe(`Действует до ${formatDate(MONTH_TAKE_OFF)}`);
    expect(describeResetSoon(noReset, ruT, ON_MOSCOW)).toBeNull();
  });

  it("counts «Мои опции» the same way, and the old wording from a panel that names no bound", () => {
    const live = entitlement({ id: "e-1", receiptName: "x", endsBound: "reset", resetAt: MONTH_RESET });
    expect(describeEntitlementEnd(live, ruT, ON_MOSCOW)).toBe(
      "Действует до сброса трафика 01.10 в 03:20 (по Москве) — через 7 дн.",
    );
    expect(describeEntitlementEnd({ ...live, state: "EXPIRED" }, ruT, ON_MOSCOW)).toBe(
      "Действует до сброса трафика 01.10 в 03:20 (по Москве)",
    );
    const old = entitlement({ id: "e-2", receiptName: "y" });
    expect(describeEntitlementEnd(old, ruT, ON_MOSCOW)).toBe(`Действует до ${formatDateTime(MONTH_TAKE_OFF)}`);
  });
});

describe("the countdown", () => {
  it("counts days on the zone's calendar — the one the date beside it is printed on", () => {
    // 24.09 22:00 → 01.10 03:20 by Moscow: seven dates on, though only 6 d 5 h 20 min apart.
    expect(countdown(new Date(MONTH_RESET), NOW, MOSCOW)).toEqual({ unit: "day", count: 7 });
    // Half past midnight by Moscow, still the evening before in UTC: six by Moscow, seven by UTC.
    const pastMoscowMidnight = new Date("2026-09-24T21:30:00.000Z");
    expect(countdown(new Date(MONTH_RESET), pastMoscowMidnight, MOSCOW)).toEqual({ unit: "day", count: 6 });
    expect(countdown(new Date(MONTH_RESET), pastMoscowMidnight, "UTC")).toEqual({ unit: "day", count: 7 });
  });

  it("goes to whole hours under a day and whole minutes under an hour, rounding down; nothing once passed", () => {
    expect(countdown(new Date(DAY_RESET), NOW, MOSCOW)).toEqual({ unit: "hour", count: 5 });
    expect(countdown(new Date(NOW.getTime() + 23 * 3_600_000 + 59 * 60_000), NOW, MOSCOW)).toEqual({
      unit: "hour",
      count: 23,
    });
    expect(countdown(new Date(NOW.getTime() + 40 * 60_000 + 59_000), NOW, MOSCOW)).toEqual({
      unit: "minute",
      count: 40,
    });
    expect(countdown(new Date(NOW.getTime() + 20_000), NOW, MOSCOW)).toEqual({ unit: "minute", count: 1 });
    expect(countdown(NOW, NOW, MOSCOW)).toBeNull();
    expect(countdown(new Date(NOW.getTime() - 60_000), NOW, MOSCOW)).toBeNull();
  });
});

describe("the dictionaries", () => {
  const KEYS = [
    "untilReset",
    "untilSubscriptionEndOn",
    "endCountdown",
    "inDays_one",
    "inDays_few",
    "inDays_many",
    "inDays_other",
    "inHours_one",
    "inHours_few",
    "inHours_many",
    "inHours_other",
    "inMinutes_one",
    "inMinutes_few",
    "inMinutes_many",
    "inMinutes_other",
    "resetSoonWarning",
  ] as const;
  const placeholders = (line: string): string[] => [...line.matchAll(/\{\{(\w+)\}\}/gu)].map((m) => m[1] ?? "").sort();

  it("carry every new line in both languages, with the same placeholders", () => {
    for (const key of KEYS) {
      expect(ru.addons[key].trim(), `ru ${key}`).not.toBe("");
      expect(en.addons[key].trim(), `en ${key}`).not.toBe("");
      expect(placeholders(en.addons[key]), key).toEqual(placeholders(ru.addons[key]));
    }
    // The sentences are translated, not copied across.
    for (const key of ["untilReset", "untilSubscriptionEndOn", "inDays_many", "inHours_many", "inMinutes_many", "resetSoonWarning"] as const) {
      expect(en.addons[key], key).not.toBe(ru.addons[key]);
    }
  });
});
