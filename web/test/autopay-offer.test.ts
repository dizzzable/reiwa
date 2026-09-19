import { describe, expect, it } from "vitest";

import {
  AUTOPAY_NOT_AVAILABLE_CODE,
  isAutopayNotAvailableRefusal,
  isProviderPeriod,
  isRepeatablePrice,
  offersAutopay,
} from "@/lib/autopay-offer";

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

  it("offers RollyPay's option on its own periods only", () => {
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: monthly })).toBe(true);
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: { ...monthly, durationDays: 60 } })).toBe(false);
    expect(offersAutopay({ gatewayType: "ROLLYPAY", autopay: true, purchase: null })).toBe(false);
  });
});

describe("isAutopayNotAvailableRefusal", () => {
  it("recognises the panel's refusal by its code alone", () => {
    expect(isAutopayNotAvailableRefusal({ response: { data: { code: AUTOPAY_NOT_AVAILABLE_CODE } } })).toBe(true);
    expect(isAutopayNotAvailableRefusal({ response: { data: { code: "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE" } } })).toBe(false);
    expect(isAutopayNotAvailableRefusal(new Error("network"))).toBe(false);
  });
});
