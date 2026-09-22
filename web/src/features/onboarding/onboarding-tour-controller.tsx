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
import {
  HINT_PRESENCE_CHANGED_EVENT,
  isHintOnScreen,
} from "@/features/hints/hint-presence";
import { useOnboardingTour } from "@/hooks/use-onboarding-tour";
import { getAllSubscriptions } from "@/lib/api-client";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import {
  listSubscriptionProvisioningReceipts,
  SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT,
} from "@/lib/subscription-provisioning-receipt";
import {
  onboardingTourMayStillStart,
  shouldAutoStartOnboardingTour,
} from "./onboarding-tour-policy";

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
   * The tour MAY start by itself: this customer has not seen it, they are on
   * the dashboard, and nothing has yet ruled it out — including the moment
   * before the subscription list has answered, which is the beat a hint used
   * to slip through. False once it has started — `isActive` says so then —
   * and for the rest of this provider's life after that.
   *
   * For anything that must not appear under the tour: the push prompt and the
   * hint controller both wait while `isActive || autoStartPending`.
   *
   * TRUE while a hint is on screen, deliberately: the tour is not about to
   * start then, it is WAITING for that hint — and everything that must not
   * appear under the tour has to keep waiting with it. Reading it the other
   * way cost the push prompt its one shot per browser, spent under a modal.
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
  // `isPending` is read as well as the data: «not answered yet» is not «no
  // subscription», and telling the two apart is what keeps a hint from
  // drawing in the beat before this read lands. See
  // `onboardingTourMayStillStart`.
  const {
    data: subsData,
    isPending: subscriptionsPending,
    fetchStatus: subscriptionsFetchStatus,
  } = useQuery<AllSubscriptionsShape>({
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
  // The other half of «the tutorial goes first» — see `hint-presence.ts`.
  // Read at mount as well as watched, because the hint controller and this
  // provider mount in whichever order the shell renders them, and a hint
  // raised before this effect ran would otherwise be invisible to it.
  const [hintOnScreen, setHintOnScreen] = useState(() => isHintOnScreen());

  useEffect(() => {
    const updateFromHintPresence = (event: Event) => {
      const detail = event as CustomEvent<{ readonly onScreen?: unknown }>;
      setHintOnScreen(
        typeof detail.detail?.onScreen === "boolean"
          ? detail.detail.onScreen
          : isHintOnScreen(),
      );
    };

    window.addEventListener(HINT_PRESENCE_CHANGED_EVENT, updateFromHintPresence);
    return () => {
      window.removeEventListener(HINT_PRESENCE_CHANGED_EVENT, updateFromHintPresence);
    };
  }, []);


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
        hintOnScreen,
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
    hintOnScreen,
    location.pathname,
    tour.shouldAutoStart,
  ]);

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
        // WIDER than the decision the auto-start effect above makes — see
        // `onboardingTourMayStillStart` for the beat that difference covers.
        autoStartPending:
          !autoStarted &&
          !tour.isActive &&
          onboardingTourMayStillStart({
            pathname: location.pathname,
            shouldAutoStart: tour.shouldAutoStart,
            // PAUSED counts as answered. React Query holds a query in
            // `pending` while the browser reports itself offline — it is not
            // retrying, it is parked — so an offline tab would have waited out
            // a read that never arrives and shown no hint for the whole visit.
            // The tour will not start off a paused read either, so there is
            // nothing to wait for.
            subscriptionsAnswered:
              !subscriptionsPending || subscriptionsFetchStatus === "paused",
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
