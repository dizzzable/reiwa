import { describe, expect, it } from "vitest";

import {
  autopayCaptionKey,
  autopayHintKey,
  approvesAutopay,
  autopayOptions,
  AUTOPAY_NOT_AVAILABLE_CODE,
  AUTOPAY_SIGN_UP_HOLD_MINUTES,
  AUTOPAY_SIGN_UP_PENDING_REASON,
  autopayRefusalMessage,
  isAutopayNotAvailableRefusal,
  isAutopaySignUpPendingRefusal,
  isProviderPeriod,
  isRepeatablePrice,
  offersAutopay,
  renewsOntoAnotherPlan,
} from "@/lib/autopay-offer";
import { en } from "@/i18n/en";
import { ru } from "@/i18n/ru";

/**
 * The payment step's «для автоматического списания» on Platega is a subscription
 * the provider repeats as it is. These pin the cabinet's copy of the panel's rule
 * (`provider-subscription-terms.util.ts` and `provider-subscription-period.util.ts`
 * in rezeis) so the option is never offered where the panel would refuse it.
 */
describe("isProviderPeriod", () => {
  it("accepts the terms Platega has a period for", () => {
    for (const days of [1, 7, 14, 28, 30, 31, 60, 90, 180, 360, 365, 730, 1095]) {
      expect(isProviderPeriod("PLATEGA", days), String(days)).toBe(true);
    }
  });

  it("refuses a term the provider would charge on a schedule nobody bought", () => {
    for (const days of [0, -30, 32, 45, 100, 364, 390, 1460, 30.5]) {
      expect(isProviderPeriod("PLATEGA", days), String(days)).toBe(false);
    }
  });

  it("gives RollyPay only its month, quarter, half-year and year tariffs", () => {
    for (const days of [30, 90, 180, 365]) {
      expect(isProviderPeriod("ROLLYPAY", days), String(days)).toBe(true);
    }
    for (const days of [1, 7, 31, 60, 360, 730]) {
      expect(isProviderPeriod("ROLLYPAY", days), String(days)).toBe(false);
    }
  });
});

describe("Antilopay", () => {
  it("has a period for a week, a month, a quarter and a year, and for nothing else", () => {
    for (const days of [7, 30, 90, 365]) {
      expect(isProviderPeriod("ANTILOPAY", days), String(days)).toBe(true);
    }
    for (const days of [1, 14, 31, 60, 180, 360, 730]) {
      expect(isProviderPeriod("ANTILOPAY", days), String(days)).toBe(false);
    }
  });

  it("is a provider subscription: offered for a purchase the provider can repeat, never for a trial or a promo price", () => {
    const monthly = { durationDays: 30, price: { currency: "RUB", price: "299" }, isTrial: false };
    const approved = { autopay: false, autopayMethods: ["CARD", "SBP"] } as const;
    expect(offersAutopay({ gatewayType: "ANTILOPAY", ...approved, purchase: monthly })).toBe(true);
    expect(offersAutopay({ gatewayType: "ANTILOPAY", ...approved, purchase: { ...monthly, durationDays: 45 } })).toBe(false);
    expect(offersAutopay({ gatewayType: "ANTILOPAY", ...approved, purchase: { ...monthly, isTrial: true } })).toBe(false);
    expect(offersAutopay({ gatewayType: "ANTILOPAY", autopay: false, autopayMethods: [], purchase: monthly })).toBe(false);
    expect(
      offersAutopay({
        gatewayType: "ANTILOPAY",
        ...approved,
        purchase: { ...monthly, price: { currency: "RUB", price: "249", discountSource: "PURCHASE" } },
      }),
    ).toBe(false);
  });

  it("is offered by the methods the operator approved, never by the boolean that other gateways read", () => {
    const monthly = { durationDays: 30, price: { currency: "RUB", price: "299" }, isTrial: false };
    // A panel older than the list sends none; nothing is offered whatever `autopay` says.
    expect(offersAutopay({ gatewayType: "ANTILOPAY", autopay: true, purchase: monthly })).toBe(false);
    expect(offersAutopay({ gatewayType: "ANTILOPAY", autopay: undefined, purchase: monthly })).toBe(false);
    expect(offersAutopay({ gatewayType: "ANTILOPAY", autopay: false, autopayMethods: ["SBP"], purchase: monthly })).toBe(true);
    expect(offersAutopay({ gatewayType: "ANTILOPAY", autopay: false, autopayMethods: ["QR"], purchase: monthly })).toBe(false);
    // And the list means nothing on a gateway with one switch.
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: false, autopayMethods: ["CARD", "SBP"], purchase: monthly })).toBe(false);
  });

  it("comes in one option per approved method — a card first, then SBP — where every other gateway has one", () => {
    expect(autopayOptions({ type: "ANTILOPAY", autopayMethods: ["CARD", "SBP"] })).toEqual(["CARD", "SBP"]);
    expect(autopayOptions({ type: "ANTILOPAY", autopayMethods: ["SBP", "CARD"] })).toEqual(["CARD", "SBP"]);
    expect(autopayOptions({ type: "ANTILOPAY", autopayMethods: ["CARD"] })).toEqual(["CARD"]);
    expect(autopayOptions({ type: "ANTILOPAY", autopayMethods: ["SBP"] })).toEqual(["SBP"]);
    expect(autopayOptions({ type: "ANTILOPAY", autopayMethods: [] })).toEqual([]);
    expect(autopayOptions({ type: "ANTILOPAY" }), "an older panel").toEqual([]);
    expect(autopayOptions({ type: "ANTILOPAY", autopayMethods: ["QR", "card"] }), "only the two it knows, as written").toEqual([]);
    for (const gateway of ["YOOKASSA", "PLATEGA", "ROLLYPAY"]) {
      expect(autopayOptions({ type: gateway, autopayMethods: ["CARD", "SBP"] }), gateway).toEqual([null]);
    }
  });

  it("asks the approval of the gateway by the one switch it has, or by its methods", () => {
    expect(approvesAutopay({ type: "YOOKASSA", autopay: true })).toBe(true);
    expect(approvesAutopay({ type: "YOOKASSA", autopay: false })).toBe(false);
    expect(approvesAutopay({ type: "ANTILOPAY", autopay: false, autopayMethods: ["CARD"] })).toBe(true);
    expect(approvesAutopay({ type: "ANTILOPAY", autopay: true })).toBe(false);
    expect(approvesAutopay({ type: "ANTILOPAY", autopayMethods: [] })).toBe(false);
  });

  it("says which way each option charges, and tells the payer the truth about it on the quote", () => {
    expect(autopayCaptionKey("CARD")).toBe("purchase.gateway.autopayCaptionCard");
    expect(autopayCaptionKey("SBP")).toBe("purchase.gateway.autopayCaptionSbp");
    expect(autopayCaptionKey(null)).toBe("purchase.gateway.autopayCaption");
    expect(autopayHintKey("ANTILOPAY", "CARD")).toBe("purchase.quote.autopayProviderCardHint");
    expect(autopayHintKey("ANTILOPAY", "SBP")).toBe("purchase.quote.autopayProviderHint");
    expect(autopayHintKey("PLATEGA", undefined)).toBe("purchase.quote.autopayProviderHint");
    expect(autopayHintKey("YOOKASSA", undefined)).toBe("purchase.quote.autopayHint");
  });

  it("has every caption and hint in both dictionaries", () => {
    for (const dictionary of [ru, en]) {
      const gateway = dictionary.purchase.gateway as Record<string, unknown>;
      const quote = dictionary.purchase.quote as Record<string, unknown>;
      for (const key of ["autopayCaption", "autopayCaptionCard", "autopayCaptionSbp"]) {
        expect(typeof gateway[key], key).toBe("string");
      }
      for (const key of ["autopayProviderHint", "autopayProviderCardHint"]) {
        expect(typeof quote[key], key).toBe("string");
      }
    }
  });
});

describe("the words for a refused autopay", () => {
  const refusal = (reason?: string) => ({
    response: { data: { code: "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE", ...(reason === undefined ? {} : { reason }) } },
  });

  it("says «сейчас недоступно» when the approval is off or the gateway refused, and not «для этой покупки»", () => {
    expect(autopayRefusalMessage(refusal("NOT_APPROVED"))).toEqual({ key: "purchase.checkout.autopayUnavailableNow" });
  });

  it("keeps the other texts for the other reasons, and for a refusal that names none", () => {
    expect(autopayRefusalMessage(refusal("DURATION"))).toEqual({ key: "purchase.checkout.autopayNotAvailable" });
    expect(autopayRefusalMessage(refusal())).toEqual({ key: "purchase.checkout.autopayNotAvailable" });
    expect(autopayRefusalMessage(refusal("PENDING_SIGN_UP")).key).toBe("purchase.checkout.autopaySignUpPending");
  });

  it("does not take the reason of another code for an autopay refusal", () => {
    const other = { response: { data: { code: "TRIAL_ALREADY_USED", reason: "NOT_APPROVED" } } };
    expect(autopayRefusalMessage(other)).toEqual({ key: "purchase.checkout.autopayNotAvailable" });
  });

  it("has the new text in both dictionaries", () => {
    expect(typeof (ru.purchase.checkout as Record<string, unknown>).autopayUnavailableNow).toBe("string");
    expect(typeof (en.purchase.checkout as Record<string, unknown>).autopayUnavailableNow).toBe("string");
  });
});

describe("isRepeatablePrice", () => {
  it("takes whole roubles, with or without a personal discount", () => {
    expect(isRepeatablePrice({ currency: "RUB", price: "299.00", discountSource: "NONE" })).toBe(true);
    expect(isRepeatablePrice({ currency: "RUB", price: 299, discountSource: "PERSONAL" })).toBe(true);
  });

  it("refuses kopecks, other currencies and a one-time promo price", () => {
    expect(isRepeatablePrice({ currency: "RUB", price: "299.90" })).toBe(false);
    expect(isRepeatablePrice({ currency: "USD", price: "3" })).toBe(false);
    expect(isRepeatablePrice({ currency: "RUB", price: "199", discountSource: "PURCHASE" })).toBe(false);
    expect(isRepeatablePrice({ currency: "RUB", price: "0" })).toBe(false);
    expect(isRepeatablePrice(undefined)).toBe(false);
  });
});

describe("offersAutopay", () => {
  const monthly = { durationDays: 30, price: { currency: "RUB", price: "299" }, isTrial: false };

  it("offers ЮKassa's option wherever the panel allows it: a saved card takes any sum", () => {
    expect(offersAutopay({ gatewayType: "YOOKASSA", autopay: true, purchase: null })).toBe(true);
    expect(offersAutopay({ gatewayType: "YOOKASSA", autopay: false, purchase: monthly })).toBe(false);
  });

  it("offers Platega's option only for a purchase the provider can repeat", () => {
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: monthly })).toBe(true);
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: { ...monthly, durationDays: 45 } })).toBe(false);
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: { ...monthly, isTrial: true } })).toBe(false);
    expect(
      offersAutopay({
        gatewayType: "PLATEGA",
        autopay: true,
        purchase: { ...monthly, price: { currency: "RUB", price: "249", discountSource: "PURCHASE" } },
      }),
    ).toBe(false);
    // Not known yet: not offered.
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: null })).toBe(false);
    // Never where the operator has not confirmed approval.
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: false, purchase: monthly })).toBe(false);
  });

  // A change of a paid plan: the panel refuses a provider subscription on it.
  // ЮKassa saves a card on any purchase, so it stays.
  it("offers no provider subscription on a change of a paid plan, and still ЮKassa's", () => {
    const change = { ...monthly, planChange: true };
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: change })).toBe(false);
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: change })).toBe(false);
    expect(offersAutopay({ gatewayType: "YOOKASSA", autopay: true, purchase: change })).toBe(true);
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: { ...monthly, planChange: false } })).toBe(true);
  });

  // Buying beside a trial converts it: an UPGRADE priced like a new purchase,
  // whose later charges renew the converted trial — the panel makes one.
  it("offers it on a trial's conversion, on the terms any purchase has", () => {
    const conversion = { ...monthly, planChange: true, convertsTrial: true };
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: conversion })).toBe(true);
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: conversion })).toBe(true);
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: true, purchase: { ...conversion, durationDays: 45 } })).toBe(false);
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: { ...conversion, durationDays: 60 } })).toBe(false);
    expect(
      offersAutopay({
        gatewayType: "PLATEGA",
        autopay: true,
        purchase: { ...conversion, price: { currency: "RUB", price: "249", discountSource: "PURCHASE" } },
      }),
    ).toBe(false);
    expect(offersAutopay({ gatewayType: "PLATEGA", autopay: false, purchase: conversion })).toBe(false);
  });

  it("offers RollyPay's option on its own periods only", () => {
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: monthly })).toBe(true);
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: { ...monthly, durationDays: 60 } })).toBe(false);
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: null })).toBe(false);
  });
});

describe("renewsOntoAnotherPlan", () => {
  it("is a renewal onto a plan other than the subscription's own", () => {
    expect(renewsOntoAnotherPlan("plan-p", "plan-replacement")).toBe(true);
    expect(renewsOntoAnotherPlan("plan-p", "plan-p")).toBe(false);
  });

  it("is no change when either plan is unknown, as for the panel", () => {
    // An imported subscription names no plan: nothing to compare.
    expect(renewsOntoAnotherPlan(null, "plan-p")).toBe(false);
    expect(renewsOntoAnotherPlan(undefined, "plan-p")).toBe(false);
    expect(renewsOntoAnotherPlan("", "plan-p")).toBe(false);
    expect(renewsOntoAnotherPlan("plan-p", null)).toBe(false);
  });
});

describe("isAutopayNotAvailableRefusal", () => {
  it("recognises the panel's refusal by its code alone", () => {
    expect(isAutopayNotAvailableRefusal({ response: { data: { code: AUTOPAY_NOT_AVAILABLE_CODE } } })).toBe(true);
    expect(isAutopayNotAvailableRefusal({ response: { data: { code: "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE" } } })).toBe(false);
    expect(isAutopayNotAvailableRefusal(new Error("network"))).toBe(false);
  });
});

describe("isAutopaySignUpPendingRefusal", () => {
  it("is the refusal whose reason is a sign-up already under way", () => {
    expect(
      isAutopaySignUpPendingRefusal({
        response: { data: { code: AUTOPAY_NOT_AVAILABLE_CODE, reason: AUTOPAY_SIGN_UP_PENDING_REASON } },
      }),
    ).toBe(true);
  });

  it("is not any other refusal, nor the reason without the code", () => {
    expect(isAutopaySignUpPendingRefusal({ response: { data: { code: AUTOPAY_NOT_AVAILABLE_CODE } } })).toBe(false);
    expect(
      isAutopaySignUpPendingRefusal({ response: { data: { code: AUTOPAY_NOT_AVAILABLE_CODE, reason: "PROMO" } } }),
    ).toBe(false);
    expect(
      isAutopaySignUpPendingRefusal({ response: { data: { code: "OTHER", reason: AUTOPAY_SIGN_UP_PENDING_REASON } } }),
    ).toBe(false);
  });

  it("gives the page its own message for it, and the ordinary-payment one otherwise", () => {
    const refusal = (data: Record<string, unknown>) => ({ response: { data: { code: AUTOPAY_NOT_AVAILABLE_CODE, ...data } } });
    expect(autopayRefusalMessage(refusal({ reason: AUTOPAY_SIGN_UP_PENDING_REASON }))).toEqual({
      key: "purchase.checkout.autopaySignUpPending",
      values: { minutes: 30 },
    });
    expect(autopayRefusalMessage(refusal({ reason: "PLAN_CHANGE" }))).toEqual({ key: "purchase.checkout.autopayNotAvailable" });
    expect(autopayRefusalMessage(refusal({}))).toEqual({ key: "purchase.checkout.autopayNotAvailable" });
  });

  it("holds as long as the panel's checkout lives, and says so without offering the ordinary payment", () => {
    // rezeis `CHECKOUT_LIFETIME_MS`: 30 minutes.
    expect(AUTOPAY_SIGN_UP_HOLD_MINUTES).toBe(30);
    for (const text of [ru.purchase.checkout.autopaySignUpPending, en.purchase.checkout.autopaySignUpPending]) {
      expect(text).toContain("{{minutes}}");
    }
    expect(ru.purchase.checkout.autopaySignUpPending).not.toMatch(/обычн/i);
    expect(en.purchase.checkout.autopaySignUpPending).not.toMatch(/ordinary/i);
  });
});
