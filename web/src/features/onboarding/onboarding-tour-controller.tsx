/**
 * OnboardingTourController
 * ────────────────────────
 * Renders the spotlight overlay + tooltip when the onboarding tour is active.
 * Mounted inside StealthLayout so it has access to the dashboard DOM elements
 * via `data-tour` selectors.
 *
 * Auto-starts on first mount when `shouldAutoStart` is true (user hasn't
 * completed the tour yet). Can also be triggered programmatically via the
 * `start()` method exposed through context.
 */

import { AnimatePresence } from "motion/react";
import { createContext, useContext, useEffect, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { SpotlightOverlay } from "./components/spotlight-overlay";
import { TourTooltip } from "./components/tour-tooltip";
import { useOnboardingTour } from "@/hooks/use-onboarding-tour";

interface OnboardingContextValue {
  /** Programmatically start (or restart) the tour. */
  startTour: () => void;
  /** Reset the completed flag and immediately replay the tour. */
  replayTour: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  startTour: () => {},
  replayTour: () => {},
});

export function useOnboardingContext() {
  return useContext(OnboardingContext);
}

export function OnboardingTourProvider({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const location = useLocation();
  const tour = useOnboardingTour();

  // Auto-start on first dashboard visit
  useEffect(() => {
    if (tour.shouldAutoStart && location.pathname === "/dashboard") {
      // Small delay so the DOM elements are rendered before we try to measure them
      const timer = setTimeout(() => tour.start(), 600);
      return () => clearTimeout(timer);
    }
  }, [location.pathname, tour.shouldAutoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const replayTour = () => {
    tour.resetOnboarding();
    tour.start();
  };

  const step = tour.currentStep;
  const title = t(`${step.i18nKey}.title` as any) as string;
  const body = t(`${step.i18nKey}.body` as any) as string;

  return (
    <OnboardingContext.Provider value={{ startTour: tour.start, replayTour }}>
      {children}
      <AnimatePresence>
        {tour.isActive && (
          <>
            <SpotlightOverlay
              targetSelector={step.targetSelector}
              onClick={tour.next}
            />
            <TourTooltip
              title={title}
              body={body}
              step={tour.stepIndex}
              totalSteps={tour.totalSteps}
              onNext={tour.next}
              onPrev={tour.prev}
              onSkip={tour.skip}
              position={step.position}
            />
          </>
        )}
      </AnimatePresence>
    </OnboardingContext.Provider>
  );
}
