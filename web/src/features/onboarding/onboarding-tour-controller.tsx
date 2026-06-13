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
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { SpotlightOverlay } from "./components/spotlight-overlay";
import { TourTooltip } from "./components/tour-tooltip";
import { DemoTutorial } from "./demo-tutorial";
import { useOnboardingTour } from "@/hooks/use-onboarding-tour";
import { getAllSubscriptions } from "@/lib/api-client";

interface OnboardingContextValue {
  /** Programmatically start (or restart) the spotlight tour (real mode). */
  startTour: () => void;
  /** Reset the completed flag and immediately replay the tour. */
  replayTour: () => void;
  /** Open the demo tutorial (sample data) — used when the trial is declined. */
  startDemo: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  startTour: () => {},
  replayTour: () => {},
  startDemo: () => {},
});

export function useOnboardingContext() {
  return useContext(OnboardingContext);
}

interface AllSubscriptionsShape {
  subscriptions?: Array<{ status?: string }>;
}

export function OnboardingTourProvider({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const location = useLocation();
  const tour = useOnboardingTour();
  const [demoOpen, setDemoOpen] = useState(false);

  // The real spotlight tour must never target a non-existent subscription
  // (Property 8). It only auto-starts once an active subscription exists.
  const { data: subsData } = useQuery<AllSubscriptionsShape>({
    queryKey: ["subscriptions", "all"],
    queryFn: getAllSubscriptions as () => Promise<AllSubscriptionsShape>,
    staleTime: 30_000,
  });
  const hasActiveSubscription =
    subsData?.subscriptions?.some((s) => s.status === "ACTIVE" || s.status === "LIMITED") ?? false;

  // Auto-start the real tour on the dashboard only when a subscription exists.
  useEffect(() => {
    if (tour.shouldAutoStart && hasActiveSubscription && location.pathname === "/dashboard") {
      // Small delay so the DOM elements are rendered before we try to measure them
      const timer = setTimeout(() => tour.start(), 600);
      return () => clearTimeout(timer);
    }
  }, [location.pathname, tour.shouldAutoStart, hasActiveSubscription]); // eslint-disable-line react-hooks/exhaustive-deps

  const replayTour = () => {
    tour.resetOnboarding();
    tour.start();
  };

  const startDemo = () => {
    setDemoOpen(true);
  };

  const closeDemo = () => {
    setDemoOpen(false);
    tour.markCompleted();
  };

  const step = tour.currentStep;
  const title = t(`${step.i18nKey}.title` as any) as string;
  const body = t(`${step.i18nKey}.body` as any) as string;

  return (
    <OnboardingContext.Provider value={{ startTour: tour.start, replayTour, startDemo }}>
      {children}
      <DemoTutorial open={demoOpen} onClose={closeDemo} />
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
