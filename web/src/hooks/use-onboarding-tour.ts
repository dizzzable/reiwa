/**
 * useOnboardingTour
 * ─────────────────
 * State machine for the onboarding tour. Manages:
 *   - Current step index.
 *   - Navigation (next / prev / skip / finish).
 *   - Persistence of "completed" flag in localStorage so the tour only
 *     shows once per device.
 *
 * The tour is triggered automatically on the first dashboard mount when
 * `hasCompletedOnboarding === false`. It can also be replayed from Settings.
 */

import { useCallback, useState } from "react";

const STORAGE_KEY = "reiwa_onboarding_completed";

export interface OnboardingStep {
  /** CSS selector for the spotlight target element. */
  readonly targetSelector: string | null;
  /** i18n key prefix for title and body (e.g. "onboarding.step1"). */
  readonly i18nKey: string;
  /** Tooltip position relative to the spotlight. */
  readonly position?: "below" | "above";
}

/**
 * Default 5-step tour matching the UX brief.
 * `targetSelector` uses `data-tour` attributes placed on the actual DOM
 * elements in the dashboard layout.
 */
export const TOUR_STEPS: readonly OnboardingStep[] = [
  {
    targetSelector: '[data-tour="subscription-card"]',
    i18nKey: "onboarding.step1",
    position: "below",
  },
  {
    targetSelector: '[data-tour="subscription-actions"]',
    i18nKey: "onboarding.step2",
    position: "below",
  },
  {
    targetSelector: '[data-tour="devices-list"]',
    i18nKey: "onboarding.step3",
    position: "above",
  },
  {
    targetSelector: '[data-tour="bottom-nav"]',
    i18nKey: "onboarding.step4",
    position: "above",
  },
  {
    targetSelector: null, // full-screen, no spotlight
    i18nKey: "onboarding.step5",
    position: "below",
  },
];

export function useOnboardingTour() {
  const [isActive, setIsActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const hasCompleted = (): boolean => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  };

  const markCompleted = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      /* storage unavailable */
    }
  };

  const start = useCallback(() => {
    setStepIndex(0);
    setIsActive(true);
  }, []);

  const next = useCallback(() => {
    if (stepIndex >= TOUR_STEPS.length - 1) {
      // Finish
      setIsActive(false);
      markCompleted();
    } else {
      setStepIndex((i) => i + 1);
    }
  }, [stepIndex]);

  const prev = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const skip = useCallback(() => {
    setIsActive(false);
    markCompleted();
  }, []);

  const shouldAutoStart = !hasCompleted();

  return {
    isActive,
    stepIndex,
    currentStep: TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0],
    totalSteps: TOUR_STEPS.length,
    start,
    next,
    prev,
    skip,
    shouldAutoStart,
  };
}
