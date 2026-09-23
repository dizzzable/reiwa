import { describe, expect, it } from "vitest";

import {
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
