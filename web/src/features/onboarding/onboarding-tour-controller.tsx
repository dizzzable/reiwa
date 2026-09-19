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
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { SpotlightOverlay } from "./components/spotlight-overlay";
import { TourTooltip } from "./components/tour-tooltip";
import { DemoTutorial } from "./demo-tutorial";
import { useOnboardingTour } from "@/hooks/use-onboarding-tour";
import { getAllSubscriptions } from "@/lib/api-client";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import {
  listSubscriptionProvisioningReceipts,
  SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT,
} from "@/lib/subscription-provisioning-receipt";
import { shouldAutoStartOnboardingTour } from "./onboarding-tour-policy";

interface OnboardingContextValue {
  /** Programmatically start (or restart) the spotlight tour (real mode). */
  startTour: () => void;
  /** Reset the completed flag and immediately replay the tour. */
  replayTour: () => void;
  /** Open the demo tutorial (sample data) — used when the trial is declined. */
  startDemo: () => void;
  /** The spotlight tour is on screen now. */
  isActive: boolean;
  /**
   * The tour is about to start by itself: this customer has not seen it, the
   * dashboard has an active subscription, no new card is still being made, and
   * the 600 ms start timer is running. False once it has started — `isActive`
   * says so then — and for the rest of this provider's life after that.
   *
   * For anything that must not appear under the tour: the push prompt waits
   * while `isActive || autoStartPending`.
   */
  autoStartPending: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  startTour: () => {},
  replayTour: () => {},
  startDemo: () => {},
  isActive: false,
  autoStartPending: false,
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
  const [hasPendingProvisioning, setHasPendingProvisioning] = useState(
    () => listSubscriptionProvisioningReceipts().length > 0,
  );

  // The real spotlight tour must never target a non-existent subscription
  // (Property 8). It only auto-starts once an active subscription exists.
  const { data: subsData } = useQuery<AllSubscriptionsShape>({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions as () => Promise<AllSubscriptionsShape>,
    staleTime: 30_000,
  });
  const hasActiveSubscription =
    subsData?.subscriptions?.some((s) => s.status === "ACTIVE" || s.status === "LIMITED") ?? false;
  // Set when the auto-start timer fires. The flag the start reads
  // (`shouldAutoStart`) only falls once the server confirms the tour was seen,
  // so without this a failed confirmation would leave the tour "due" forever.
  const [autoStarted, setAutoStarted] = useState(false);

  // Provisioning lives in session storage because it bridges purchase and
  // dashboard routes. This notification keeps the tour's visible state in
  // sync with that external store without polling.
  useEffect(() => {
    const updateFromReceiptChange = (event: Event) => {
      const detail = event as CustomEvent<{
        readonly hasPendingProvisioning?: unknown;
      }>;
      if (typeof detail.detail?.hasPendingProvisioning === "boolean") {
        setHasPendingProvisioning(detail.detail.hasPendingProvisioning);
        return;
      }
      setHasPendingProvisioning(
        listSubscriptionProvisioningReceipts().length > 0,
      );
    };

    window.addEventListener(
      SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT,
      updateFromReceiptChange,
    );
    return () => {
      window.removeEventListener(
        SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT,
        updateFromReceiptChange,
      );
    };
  }, []);

  // Auto-start only after the real card exists; a transient creation card must
  // finish its own sequence before the spotlight may target this area.
  useEffect(() => {
    if (
      shouldAutoStartOnboardingTour({
        pathname: location.pathname,
        shouldAutoStart: tour.shouldAutoStart,
        hasActiveSubscription,
        hasPendingProvisioning,
      })
    ) {
      // Small delay so the DOM elements are rendered before we try to measure them
      const timer = setTimeout(() => {
        setAutoStarted(true);
        tour.start();
        // Mark the tour as seen the moment it auto-starts (not only on
        // finish/skip), so a page reload mid-tour doesn't relaunch it for the
        // user. Replay stays available from Settings (resetOnboarding + start).
        tour.markCompleted();
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [
    hasActiveSubscription,
    hasPendingProvisioning,
    location.pathname,
    tour.shouldAutoStart,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <OnboardingContext.Provider
      value={{
        startTour: tour.start,
        replayTour,
        startDemo,
        isActive: tour.isActive,
        // The same decision the auto-start effect above makes, read in render.
        autoStartPending:
          !autoStarted &&
          !tour.isActive &&
          shouldAutoStartOnboardingTour({
            pathname: location.pathname,
            shouldAutoStart: tour.shouldAutoStart,
            hasActiveSubscription,
            hasPendingProvisioning,
          }),
      }}
    >
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
