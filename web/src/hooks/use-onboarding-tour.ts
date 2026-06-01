/**
 * useOnboardingTour
 * ─────────────────
 * State machine for the onboarding tour. Manages:
 *   - Current step index.
 *   - Navigation (next / prev / skip / finish).
 *   - Persistence of the "completed" flag.
 *
 * Persistence is server-backed (so the state follows the user across
 * devices/browsers) with a localStorage mirror for instant first paint
 * before the session has loaded. The server flag (`session.onboardingCompleted`)
 * is authoritative; localStorage is only a hint to avoid a flash of the tour
 * on a device that has already seen it.
 *
 * The tour is triggered automatically on the first dashboard mount when the
 * user has not completed it. It can also be replayed from Settings via
 * `start()` after `resetOnboarding()`.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { setOnboardingCompleted } from "@/lib/api-client";
import { SESSION_QUERY_KEY, useSession } from "@/hooks/use-session";

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

function readLocalCompleted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeLocalCompleted(value: boolean) {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, "true");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function useOnboardingTour() {
  const [isActive, setIsActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const { session } = useSession();
  const queryClient = useQueryClient();

  // Server flag is authoritative once the session is loaded; fall back to the
  // localStorage hint while it's still loading so a returning user doesn't see
  // a flash of the tour.
  const serverCompleted = session?.onboardingCompleted;
  const hasCompleted =
    typeof serverCompleted === "boolean" ? serverCompleted : readLocalCompleted();

  const persistCompleted = (value: boolean) => {
    writeLocalCompleted(value);
    setOnboardingCompleted(value)
      .then(() => {
        // Refresh the session so `onboardingCompleted` reflects the new state.
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      })
      .catch(() => {
        /* best-effort: localStorage hint already updated */
      });
  };

  const start = useCallback(() => {
    setStepIndex(0);
    setIsActive(true);
  }, []);

  const next = useCallback(() => {
    setStepIndex((i) => {
      if (i >= TOUR_STEPS.length - 1) {
        setIsActive(false);
        persistCompleted(true);
        return i;
      }
      return i + 1;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prev = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const skip = useCallback(() => {
    setIsActive(false);
    persistCompleted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Clears the completed flag (server + local) so the tour can replay. */
  const resetOnboarding = useCallback(() => {
    persistCompleted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shouldAutoStart = !hasCompleted;

  return {
    isActive,
    stepIndex,
    currentStep: TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0],
    totalSteps: TOUR_STEPS.length,
    start,
    next,
    prev,
    skip,
    resetOnboarding,
    shouldAutoStart,
  };
}
