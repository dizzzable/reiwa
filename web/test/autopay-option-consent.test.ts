// @vitest-environment jsdom

/**
 * «для автоматического списания» replaced the «Сохранить карту для
 * автоплатежей» switch (19.09.2026). Picking that option IS the customer's
 * consent to save the method: the stores turn the choice into
 * `savePaymentMethodConsent`, which the checkout sends for an interactive
 * ЮKassa payment. Picking the plain row of the same gateway must not consent.
 */
import { describe, expect, it } from "vitest";

import { usePurchaseStore } from "../src/stores/purchase.store";
import { useRenewalStore } from "../src/stores/renewal.store";

const YOOKASSA = { id: "YOOKASSA", label: "ЮKassa", icon: "💳", currency: "RUB" };

describe("picking «для автоматического списания»", () => {
  it("consents to saving the method on a purchase, and the plain row does not", () => {
    usePurchaseStore.getState().selectGateway({ ...YOOKASSA, autopay: true });
    expect(usePurchaseStore.getState().savePaymentMethodConsent).toBe(true);

    usePurchaseStore.getState().selectGateway(YOOKASSA);
    expect(usePurchaseStore.getState().savePaymentMethodConsent).toBe(false);
  });

  it("consents to saving the method on a renewal, and the plain row does not", () => {
    useRenewalStore.getState().selectGateway({ ...YOOKASSA, autopay: true });
    expect(useRenewalStore.getState().savePaymentMethodConsent).toBe(true);

    useRenewalStore.getState().selectGateway(YOOKASSA);
    expect(useRenewalStore.getState().savePaymentMethodConsent).toBe(false);
  });
});
