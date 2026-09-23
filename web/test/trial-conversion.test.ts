import { describe, expect, it } from "vitest";

import {
  isTrialConversionRequiredRefusal,
  TRIAL_UPGRADE_REQUIRED_CODE,
  trialToConvert,
} from "../src/lib/trial-conversion";
import type { Subscription, SubscriptionStatus } from "../src/types/api";

function subscription(id: string, isTrial: boolean, status: SubscriptionStatus): Subscription {
  return { id, isTrial, status, userRemnaId: null } as Subscription;
}

describe("trialToConvert", () => {
  it("takes the trial a purchase would otherwise stand beside", () => {
    const trial = subscription("trial", true, "ACTIVE");
    expect(trialToConvert([subscription("paid", false, "ACTIVE"), trial])).toBe(trial);
  });

  it("converts an expired or limited trial too: the link the buyer set up stays", () => {
    expect(trialToConvert([subscription("t", true, "EXPIRED")])?.id).toBe("t");
    expect(trialToConvert([subscription("t", true, "LIMITED")])?.id).toBe("t");
  });

  it("prefers a live trial to an expired one", () => {
    const list = [subscription("old", true, "EXPIRED"), subscription("live", true, "LIMITED")];
    expect(trialToConvert(list)?.id).toBe("live");
  });

  it("leaves a DISABLED trial alone — an upgrade would lift the operator's freeze", () => {
    expect(trialToConvert([subscription("t", true, "DISABLED")])).toBeNull();
    expect(trialToConvert([subscription("t", true, "DELETED")])).toBeNull();
  });

  it("finds nothing without a trial, or without a list", () => {
    expect(trialToConvert([subscription("paid", false, "ACTIVE")])).toBeNull();
    expect(trialToConvert(undefined)).toBeNull();
  });
});

describe("isTrialConversionRequiredRefusal", () => {
  it("recognises the panel's refusal by its code alone", () => {
    expect(
      isTrialConversionRequiredRefusal({ response: { data: { code: TRIAL_UPGRADE_REQUIRED_CODE } } }),
    ).toBe(true);
    expect(
      isTrialConversionRequiredRefusal({ response: { data: { code: "SUBSCRIPTION_LIMIT_REACHED" } } }),
    ).toBe(false);
    expect(isTrialConversionRequiredRefusal(new Error("network"))).toBe(false);
  });
});
