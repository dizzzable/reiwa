/**
 * A customer's subscription dates on the operator's clock (the owner's rule:
 * dates are read in the panel's «Часовой пояс», as the bot's notices print
 * them).
 *
 * «Главная» printed the end of a subscription on the phone's calendar, so near
 * midnight it named another day than the notice about the same end; and its
 * «N дней» was elapsed time rounded up, which could contradict the date beside
 * it on either calendar. The picker in the renewal, upgrade and add-on wizards,
 * the connect screen, the subscription page, the devices and the upgrade's
 * add-on line printed theirs the same way.
 *
 * Asia/Vladivostok is UTC+10 all year: past 14:00 UTC it is already the next
 * day there — another day than on this machine's calendar, Moscow or UTC.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const operator = vi.hoisted(() => ({ zone: undefined as string | undefined }));

vi.mock("@/lib/operator-time-zone", () => ({ useOperatorTimeZone: () => operator.zone }));
vi.mock("@/lib/branding-provider", async () => {
  const { DEFAULT_BRANDING } = await import("../src/types/branding");
  return { useBranding: () => ({ branding: DEFAULT_BRANDING, customIcons: [] }) };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key}(${Object.entries(options).map(([name, value]) => `${name}=${String(value)}`).join(",")})`,
  }),
}));

import { SubscriptionSelectCard } from "../src/components/subscription/subscription-select-card";
import { describePurchaseMoment } from "../src/features/addons/add-on-end";
import { SubscriptionCardContent } from "../src/features/dashboard/components/subscription-card";
import { subscriptionCardEnd } from "../src/features/dashboard/components/subscription-card-end";
import { describeActiveAddOns } from "../src/features/upgrade/active-add-ons";
import { calendarDaysUntil, customerDateZone } from "../src/lib/operator-zone";
import { formatDate, formatDateTime } from "../src/lib/utils";
import type { Subscription } from "../src/types/api";

const VLADIVOSTOK = "Asia/Vladivostok";
/** 01.10 at 18:30 in Moscow, 15:30 in UTC — and 02.10 at 01:30 in Vladivostok. */
const END = "2026-10-01T15:30:00Z";

function subscription(expiresAt: string | null): Subscription {
  return {
    id: "cmsub0001abcdefghijklmno",
    status: "ACTIVE",
    expiresAt,
    trafficUsed: 10,
    trafficLimit: 100,
    deviceLimit: 3,
    plan: { name: "Базовый" },
  } as unknown as Subscription;
}

beforeEach(() => {
  vi.useFakeTimers();
  operator.zone = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("«Главная»: the card’s end on the operator’s clock", () => {
  it("prints the day the operator’s calendar says, not the phone’s", () => {
    vi.setSystemTime(new Date("2026-09-24T20:00:00Z"));
    operator.zone = VLADIVOSTOK;
    const markup = renderToStaticMarkup(<SubscriptionCardContent subscription={subscription(END)} />);
    expect(markup).toContain('card.untilDate(date=02.10.26)');
    // 25.09 → 02.10 on that calendar.
    expect(markup).toContain('card.daysLeft(count=7)');
  });

  it("counts the days on the calendar of the date beside them — never one more than it shows", () => {
    // 7 days and 22 hours ahead: rounded up, that was «8 дней — до 01.10».
    vi.setSystemTime(new Date("2026-09-24T01:00:00Z"));
    operator.zone = "UTC";
    const markup = renderToStaticMarkup(<SubscriptionCardContent subscription={subscription("2026-10-01T23:00:00Z")} />);
    expect(markup).toContain('card.untilDate(date=01.10.26)');
    expect(markup).toContain('card.daysLeft(count=7)');
  });

  it("under a day: whole hours — not «1 день» beside today’s date", () => {
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    operator.zone = VLADIVOSTOK;
    const markup = renderToStaticMarkup(<SubscriptionCardContent subscription={subscription(END)} />);
    expect(markup).toContain('card.hoursLeft(count=5)');
    expect(markup).not.toContain("card.daysLeft");
  });

  it("under an hour: whole minutes", () => {
    vi.setSystemTime(new Date("2026-10-01T15:00:30Z"));
    operator.zone = VLADIVOSTOK;
    const markup = renderToStaticMarkup(<SubscriptionCardContent subscription={subscription(END)} />);
    expect(markup).toContain('card.minutesLeft(count=29)');
  });
});

describe("subscriptionCardEnd", () => {
  const now = new Date("2026-09-24T20:00:00Z");

  it("reads the phone’s calendar while the panel has not named its zone", () => {
    expect(subscriptionCardEnd(END, undefined, now, VLADIVOSTOK)?.date).toBe("02.10.26");
    expect(subscriptionCardEnd(END, undefined, now, "UTC")?.date).toBe("01.10.26");
  });

  it("is nothing without an end, and 0 days — the danger accent — once it has passed", () => {
    expect(subscriptionCardEnd(null, VLADIVOSTOK, now)).toBeNull();
    expect(subscriptionCardEnd("not a date", VLADIVOSTOK, now)).toBeNull();
    expect(subscriptionCardEnd("2026-09-20T00:00:00Z", VLADIVOSTOK, now)).toMatchObject({
      left: { unit: "day", count: 0 },
      urgency: "danger",
    });
  });

  it("tints under four days and under eight, as it did", () => {
    const at = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000 + 60_000).toISOString();
    expect(subscriptionCardEnd(at(3), "UTC", now)?.urgency).toBe("danger");
    expect(subscriptionCardEnd(at(5), "UTC", now)?.urgency).toBe("warning");
    expect(subscriptionCardEnd(at(9), "UTC", now)?.urgency).toBeNull();
  });
});

describe("the other subscription dates on the operator’s clock", () => {
  it("the picker of the renewal, upgrade and add-on wizards", () => {
    vi.setSystemTime(new Date("2026-09-24T20:00:00Z"));
    operator.zone = VLADIVOSTOK;
    const markup = renderToStaticMarkup(
      <SubscriptionSelectCard subscription={subscription(END)} selected={false} onSelect={() => undefined} />,
    );
    expect(markup).toContain("subscriptionPicker.expires: 02.10.26");
  });

  it("the upgrade’s line of the add-ons kept", () => {
    const t = ((key: string, options?: Record<string, unknown>) =>
      `${key}(${JSON.stringify(options ?? {})})`) as never;
    const line = describeActiveAddOns(
      [{ type: "EXTRA_DEVICES", value: 2, expiresAt: END }] as never,
      { trafficLimit: 100, deviceLimit: 3 } as never,
      t,
      VLADIVOSTOK,
    );
    expect(line).toContain('\\"date\\":\\"02.10.26\\"');
  });

  it("formatDate reads the calendar of the zone it is given", () => {
    expect(formatDate(END, VLADIVOSTOK)).toBe("02.10.26");
    expect(formatDate(END, "UTC")).toBe("01.10.26");
  });

  it("«Мои опции»: when it was bought, on the operator’s clock with the zone named — the phone’s, unnamed, while none is known", () => {
    // 06:50 on 25.09 in Vladivostok.
    const bought = "2026-09-24T20:50:00Z";
    const named = describePurchaseMoment(bought, { displayTimeZone: VLADIVOSTOK, language: "ru" });
    expect(named).toBe(`${formatDateTime(bought, VLADIVOSTOK)} (по Владивостоку)`);
    expect(named).toContain("06:50");
    expect(describePurchaseMoment(bought, { displayTimeZone: undefined, language: "ru" })).toBe(formatDateTime(bought));
    expect(describePurchaseMoment("not a date", { displayTimeZone: VLADIVOSTOK, language: "ru" })).toBe("—");
  });

  it("counts calendar days on the zone’s calendar", () => {
    const now = new Date("2026-09-24T20:00:00Z");
    expect(calendarDaysUntil(new Date(END), now, VLADIVOSTOK)).toBe(7);
    expect(calendarDaysUntil(new Date(END), now, "UTC")).toBe(7);
    expect(calendarDaysUntil(new Date("2026-09-25T13:00:00Z"), now, VLADIVOSTOK)).toBe(0);
  });

  it("takes the panel’s zone once it is named — none set is UTC — and nothing while it is not", () => {
    expect(customerDateZone(undefined)).toBeUndefined();
    expect(customerDateZone(null)).toBe("UTC");
    expect(customerDateZone("Europe/Moscow")).toBe("Europe/Moscow");
    expect(customerDateZone("Mars/Olympus_Mons")).toBe("UTC");
  });
});

/**
 * The pages whose dates are not rendered above — they need the whole page to
 * draw — read as source: every date they print goes through `formatDate` with
 * the operator's zone, and none through the phone's own formatting or the
 * rounded-up day count; and the signed-in shell provides the zone.
 */
describe("every page that prints a subscription date reads it on the operator’s calendar", () => {
  const PAGES = [
    "features/subscription/subscription-page.tsx",
    "features/connect/connect-page.tsx",
    "features/settings/payment-methods-page.tsx",
    "features/subscription/devices-page.tsx",
    "features/dashboard/components/devices-list.tsx",
    "features/dashboard/components/subscription-card.tsx",
    "components/subscription/subscription-select-card.tsx",
  ];

  /** Each `formatDate(…)` call's argument text, parentheses balanced. */
  function formatDateCalls(source: string): string[] {
    const calls: string[] = [];
    for (let at = source.indexOf("formatDate("); at >= 0; at = source.indexOf("formatDate(", at + 1)) {
      let depth = 0;
      let end = at + "formatDate".length;
      for (; end < source.length; end += 1) {
        if (source[end] === "(") depth += 1;
        else if (source[end] === ")" && --depth === 0) break;
      }
      calls.push(source.slice(at, end + 1));
    }
    return calls;
  }

  it.each(PAGES)("%s", async (page) => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(__dirname, "../src", page), "utf8");
    const calls = formatDateCalls(source);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => !call.includes("dateZone"))).toEqual([]);
    expect(source).not.toMatch(/toLocaleDateString\(|getDaysLeft\(/);
  });

  it("the signed-in shell provides the zone to both of its layouts", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(__dirname, "../src/components/layout/stealth-layout.tsx"), "utf8");
    expect(source.match(/<OperatorTimeZoneProvider>/g)).toHaveLength(2);
    expect(source.match(/<\/OperatorTimeZoneProvider>/g)).toHaveLength(2);
  });
});
