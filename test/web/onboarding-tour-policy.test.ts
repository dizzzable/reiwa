import { describe, expect, it } from "vitest";

import { shouldAutoStartOnboardingTour } from "../../web/src/features/onboarding/onboarding-tour-policy.js";

describe("onboarding tour policy", () => {
  const eligibleDashboard = {
    pathname: "/dashboard",
    shouldAutoStart: true,
    hasActiveSubscription: true,
    hasPendingProvisioning: false,
    hintOnScreen: false,
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

  it("waits for a hint that is already on screen", () => {
    // The two are raised by the same moment — a finished purchase — and
    // until 21.09.2026 the spotlight opened straight over «Готово! Подписка
    // оформлена», dimming a modal it could not see. The tour stays DUE while
    // it waits: `markCompleted` runs when it starts, not when it becomes due,
    // so closing the hint lets it through.
    expect(
      shouldAutoStartOnboardingTour({
        ...eligibleDashboard,
        hintOnScreen: true,
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
