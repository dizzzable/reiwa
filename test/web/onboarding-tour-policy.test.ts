import { describe, expect, it } from "vitest";

import { shouldAutoStartOnboardingTour } from "../../web/src/features/onboarding/onboarding-tour-policy.js";

describe("onboarding tour policy", () => {
  const eligibleDashboard = {
    pathname: "/dashboard",
    shouldAutoStart: true,
    hasActiveSubscription: true,
    hasPendingProvisioning: false,
  };

  it("starts the tour for a ready subscription on the dashboard", () => {
    expect(shouldAutoStartOnboardingTour(eligibleDashboard)).toBe(true);
  });

  it("waits for the creation animation to hand off before starting", () => {
    expect(
      shouldAutoStartOnboardingTour({
        ...eligibleDashboard,
        hasPendingProvisioning: true,
      }),
    ).toBe(false);
  });

  it("never auto-starts outside the dashboard or without an active subscription", () => {
    expect(
      shouldAutoStartOnboardingTour({
        ...eligibleDashboard,
        pathname: "/settings",
      }),
    ).toBe(false);
    expect(
      shouldAutoStartOnboardingTour({
        ...eligibleDashboard,
        hasActiveSubscription: false,
      }),
    ).toBe(false);
  });
});
