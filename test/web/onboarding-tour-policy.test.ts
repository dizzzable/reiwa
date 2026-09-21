import { describe, expect, it } from "vitest";

import {
  onboardingTourMayStillStart,
  shouldAutoStartOnboardingTour,
} from "../../web/src/features/onboarding/onboarding-tour-policy.js";

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

describe("what everything else has to wait for", () => {
  const overlayWait = {
    pathname: "/dashboard",
    shouldAutoStart: true,
    subscriptionsAnswered: true,
    hasActiveSubscription: true,
    hasPendingProvisioning: false,
  };

  it("keeps overlays waiting while a hint holds the screen", () => {
    // THE ASYMMETRY, and it cost the push prompt its one shot per browser.
    // A hint on screen means the tour is WAITING, not that it is not coming —
    // so the tour itself must not start, and everything that must not appear
    // under the tour must keep waiting with it. Read the other way, the push
    // card decided its turn had come, wrote «shown» and cleared its
    // eligibility underneath a modal the customer had not closed yet.
    expect(
      shouldAutoStartOnboardingTour({ ...overlayWait, hintOnScreen: true }),
      "the tour started over a hint",
    ).toBe(false);
    expect(
      onboardingTourMayStillStart(overlayWait),
      "overlays stopped waiting while the tour was queued behind a hint",
    ).toBe(true);
  });

  it("waits out a subscription list that has not answered", () => {
    // The beat the whole repair is about: on a fresh dashboard the answer
    // arrives after the page does, and in that beat the tour is not due by
    // the start rule — so a hint asked before the tour could know.
    expect(
      onboardingTourMayStillStart({
        ...overlayWait,
        subscriptionsAnswered: false,
        hasActiveSubscription: false,
      }),
    ).toBe(true);
  });

  it("stops waiting once the answer rules the tour out", () => {
    // ANTI-VACUITY, and the bound on the wait. An answered read with no
    // active subscription, and any page that is not the dashboard, end it —
    // otherwise a customer without a subscription would never see a hint.
    expect(
      onboardingTourMayStillStart({ ...overlayWait, hasActiveSubscription: false }),
    ).toBe(false);
    expect(onboardingTourMayStillStart({ ...overlayWait, pathname: "/settings" })).toBe(false);
    expect(onboardingTourMayStillStart({ ...overlayWait, shouldAutoStart: false })).toBe(false);
    // A stuck provisioning receipt lives 24 hours; waiting on it would hold a
    // hint for a day, so it ends the wait too — the tour simply starts later,
    // and the hint-on-screen rule is what stops it landing on anything.
    expect(
      onboardingTourMayStillStart({ ...overlayWait, hasPendingProvisioning: true }),
    ).toBe(false);
  });
});
