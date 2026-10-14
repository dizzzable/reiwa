/**
 * «Отсрочка первого списания по СБП»: reading the delay the panel names, and
 * saying it — in the right case, in both languages.
 *
 * The consent step and the caption of the option say "access for 2 weeks starts
 * right away, the first charge comes after 2 weeks", and the unit has to agree
 * with the number: «1 неделю», «2 недели», «5 недель», «21 неделю». The real
 * dictionaries, the real plural rules.
 */
import i18next, { type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AUTOPAY_DELAY_UNITS,
  autopayDelayFor,
  autopayTail,
  describeAutopayDelay,
  readAutopayDelay,
  type AutopayDelay,
} from "../src/lib/autopay-delay";
import { isAutopayDelayChangedRefusal, autopayRefusalMessage } from "../src/lib/autopay-offer";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";

const SEVEN_DAYS = { count: 7, unit: "DAY", days: 7 } as const;

describe("reading the delay the panel names", () => {
  it("takes a count, one of Antilopay's five words and the days they are worth", () => {
    expect(readAutopayDelay(SEVEN_DAYS)).toEqual(SEVEN_DAYS);
    expect(readAutopayDelay({ count: 2, unit: "WEEK", days: 14 })).toEqual({ count: 2, unit: "WEEK", days: 14 });
    expect(readAutopayDelay({ count: 1, unit: "MONTH", days: 30 })).toEqual({ count: 1, unit: "MONTH", days: 30 });
    expect(readAutopayDelay({ count: 1, unit: "QUARTER", days: 90 })).toEqual({ count: 1, unit: "QUARTER", days: 90 });
    expect(readAutopayDelay({ count: 1, unit: "YEAR", days: 365 })).toEqual({ count: 1, unit: "YEAR", days: 365 });
    expect([...AUTOPAY_DELAY_UNITS]).toEqual(["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]);
  });

  it.each([
    ["a unit in the wrong case", { count: 7, unit: "day", days: 7 }],
    ["a unit that is not Antilopay's", { count: 7, unit: "HOUR", days: 7 }],
    ["days that disagree with the count and the unit", { count: 7, unit: "DAY", days: 8 }],
    ["no days", { count: 7, unit: "DAY" }],
    ["a count of 0", { count: 0, unit: "DAY", days: 0 }],
    ["a fractional count", { count: 1.5, unit: "DAY", days: 1.5 }],
    ["a count as text", { count: "7", unit: "DAY", days: 7 }],
    ["more than a year", { count: 2, unit: "YEAR", days: 730 }],
    ["a string", "7 DAY"],
    ["an array", [7, "DAY"]],
    ["null", null],
    ["nothing", undefined],
  ])("reads %s as none", (_name, value) => {
    expect(readAutopayDelay(value)).toBeNull();
  });
});

describe("whose delay it is", () => {
  const gateway = { type: "ANTILOPAY", autopayDelay: SEVEN_DAYS };

  it("belongs to an Antilopay SBP sign-up and to nothing else: a card's first payment is charged on the form", () => {
    expect(autopayDelayFor(gateway, "SBP")).toEqual(SEVEN_DAYS);
    expect(autopayDelayFor(gateway, "CARD")).toBeNull();
    expect(autopayDelayFor(gateway, null)).toBeNull();
    expect(autopayDelayFor(gateway, undefined)).toBeNull();
    expect(autopayDelayFor({ type: "PLATEGA", autopayDelay: SEVEN_DAYS }, "SBP")).toBeNull();
  });

  it("is none from a panel that names none, and from one whose delay cannot be read", () => {
    expect(autopayDelayFor({ type: "ANTILOPAY" }, "SBP")).toBeNull();
    expect(autopayDelayFor({ type: "ANTILOPAY", autopayDelay: { count: 7, unit: "day", days: 7 } }, "SBP")).toBeNull();
  });
});

describe("what a checkout sends after the consent", () => {
  it("is the method and the delay shown beside it, as a count and the panel's word", () => {
    const delay: AutopayDelay = { count: 2, unit: "WEEK", days: 14 };
    expect(autopayTail("SBP", delay)).toEqual(["SBP", { count: 2, unit: "WEEK" }]);
  });

  it("keeps the shorter forms: a method alone, or nothing", () => {
    expect(autopayTail("SBP", null)).toEqual(["SBP"]);
    expect(autopayTail("CARD", undefined)).toEqual(["CARD"]);
    expect(autopayTail(undefined, null)).toEqual([]);
    // A delay without a method is nothing the panel could use.
    expect(autopayTail(undefined, SEVEN_DAYS)).toEqual([]);
  });
});

describe("the delay in words", () => {
  const instances = new Map<string, TFunction>();

  beforeAll(async () => {
    for (const [lng, translation] of [
      ["ru", ru],
      ["en", en],
    ] as const) {
      const instance = i18next.createInstance();
      await instance.init({ lng, resources: { [lng]: { translation } }, interpolation: { escapeValue: false } });
      instances.set(lng, instance.t.bind(instance) as TFunction);
    }
  });

  const say = (lng: string, count: number, unit: AutopayDelay["unit"]): string =>
    describeAutopayDelay(instances.get(lng)!, { count, unit, days: 1 });

  it.each([
    [1, "1 день"],
    [2, "2 дня"],
    [4, "4 дня"],
    [5, "5 дней"],
    [11, "11 дней"],
    [14, "14 дней"],
    [21, "21 день"],
    [22, "22 дня"],
    [25, "25 дней"],
    [30, "30 дней"],
  ] as const)("says %i days in Russian: %s", (count, expected) => {
    expect(say("ru", count, "DAY")).toBe(expected);
  });

  it.each([
    [1, "1 неделю"],
    [2, "2 недели"],
    [4, "4 недели"],
    [5, "5 недель"],
    [11, "11 недель"],
    [21, "21 неделю"],
    [22, "22 недели"],
  ] as const)("says %i weeks in Russian, after «на» and «через» alike: %s", (count, expected) => {
    expect(say("ru", count, "WEEK")).toBe(expected);
  });

  it.each([
    [1, "1 месяц"],
    [2, "2 месяца"],
    [5, "5 месяцев"],
    [11, "11 месяцев"],
    [12, "12 месяцев"],
  ] as const)("says %i months in Russian: %s", (count, expected) => {
    expect(say("ru", count, "MONTH")).toBe(expected);
  });

  it.each([
    [1, "1 квартал"],
    [2, "2 квартала"],
    [4, "4 квартала"],
  ] as const)("says %i quarters in Russian: %s", (count, expected) => {
    expect(say("ru", count, "QUARTER")).toBe(expected);
  });

  it.each([
    [1, "1 год"],
    [2, "2 года"],
    [5, "5 лет"],
  ] as const)("says %i years in Russian: %s", (count, expected) => {
    expect(say("ru", count, "YEAR")).toBe(expected);
  });

  it("says every unit in English, singular for one and plural for the rest", () => {
    expect(say("en", 1, "DAY")).toBe("1 day");
    expect(say("en", 7, "DAY")).toBe("7 days");
    expect(say("en", 1, "WEEK")).toBe("1 week");
    expect(say("en", 2, "WEEK")).toBe("2 weeks");
    expect(say("en", 1, "MONTH")).toBe("1 month");
    expect(say("en", 3, "MONTH")).toBe("3 months");
    expect(say("en", 1, "QUARTER")).toBe("1 quarter");
    expect(say("en", 2, "QUARTER")).toBe("2 quarters");
    expect(say("en", 1, "YEAR")).toBe("1 year");
    expect(say("en", 2, "YEAR")).toBe("2 years");
  });

  it("has a form for every unit and every plural category in both languages", () => {
    for (const dictionary of [ru, en]) {
      for (const unit of AUTOPAY_DELAY_UNITS) {
        for (const category of ["one", "few", "many", "other"]) {
          expect(dictionary.autopayDelay.duration, `${unit}_${category}`).toHaveProperty(`${unit}_${category}`);
        }
      }
    }
  });
});

describe("the sentences the consent is made of", () => {
  const sentence = async (lng: "ru" | "en", key: string, values: Record<string, unknown>): Promise<string> => {
    const instance = i18next.createInstance();
    await instance.init({
      lng,
      resources: { [lng]: { translation: lng === "ru" ? ru : en } },
      interpolation: { escapeValue: false },
    });
    return instance.t(key, values);
  };

  it("says in Russian that nothing is charged now, what starts at once, when the first charge comes and then every term", async () => {
    const text = await sentence("ru", "purchase.quote.autopayDelayHint", {
      delay: "2 недели",
      amount: "₽299.00 RUB",
      term: "30 дней",
    });
    expect(text).toContain("Сейчас ничего не спишется");
    expect(text).toContain("доступ к тарифу откроется сразу на 2 недели");
    expect(text).toContain("Первое списание ₽299.00 RUB произойдёт через 2 недели");
    expect(text).toContain("в начале каждого срока (30 дней)");
    expect(text).toContain("«Способах оплаты»");
    expect(text).not.toContain("спишется сейчас");
  });

  it("says the same in English", async () => {
    const text = await sentence("en", "purchase.quote.autopayDelayHint", {
      delay: "1 week",
      amount: "₽299.00 RUB",
      term: "30 days",
    });
    expect(text).toContain("Nothing is charged now");
    expect(text).toContain("access to the plan starts right away for 1 week");
    expect(text).toContain("The first charge of ₽299.00 RUB comes after 1 week");
    expect(text).toContain("at the start of each term (30 days)");
    expect(text).toContain("Payment methods");
  });

  it("captions the option with the same facts, with the sum where it is known and without it where it is not", async () => {
    const ruWith = await sentence("ru", "purchase.gateway.autopayCaptionSbpDelay", { delay: "7 дней", amount: "₽299.00 RUB" });
    expect(ruWith).toContain("по СБП, для автоматического списания");
    expect(ruWith).toContain("Сейчас ничего не спишется");
    expect(ruWith).toContain("доступ на 7 дней откроется сразу");
    expect(ruWith).toContain("первое списание ₽299.00 RUB — через 7 дней");
    const ruShort = await sentence("ru", "purchase.gateway.autopayCaptionSbpDelayShort", { delay: "7 дней" });
    expect(ruShort).toContain("первое списание — через 7 дней");
    const enWith = await sentence("en", "purchase.gateway.autopayCaptionSbpDelay", { delay: "7 days", amount: "₽299.00 RUB" });
    expect(enWith).toContain("Nothing is charged now: access for 7 days starts right away");
    expect(enWith).toContain("the first charge of ₽299.00 RUB comes after 7 days");
    const enShort = await sentence("en", "purchase.gateway.autopayCaptionSbpDelayShort", { delay: "7 days" });
    expect(enShort).toContain("the first charge comes after 7 days");
  });

  it("tells a customer whose delay changed that nothing was charged", async () => {
    expect(await sentence("ru", "purchase.checkout.autopayDelayChanged", {})).toContain("Ничего не списано");
    expect(await sentence("en", "purchase.checkout.autopayDelayChanged", {})).toContain("Nothing was charged");
  });
});

describe("the panel's refusal when the delay shown is gone", () => {
  const refusal = (reason: string) => ({
    response: { data: { code: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", message: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", reason } },
  });

  it("is told apart from the others, and has its own words", () => {
    expect(isAutopayDelayChangedRefusal(refusal("DELAY_CHANGED"))).toBe(true);
    expect(isAutopayDelayChangedRefusal(refusal("NOT_APPROVED"))).toBe(false);
    expect(isAutopayDelayChangedRefusal({ response: { data: { code: "OTHER", reason: "DELAY_CHANGED" } } })).toBe(false);
    expect(isAutopayDelayChangedRefusal(new Error("x"))).toBe(false);
    expect(autopayRefusalMessage(refusal("DELAY_CHANGED")).key).toBe("purchase.checkout.autopayDelayChanged");
    expect(autopayRefusalMessage(refusal("DURATION")).key).toBe("purchase.checkout.autopayNotAvailable");
  });
});
