export interface OnboardingTourAutoStartInput {
  readonly pathname: string;
  readonly shouldAutoStart: boolean;
  readonly hasActiveSubscription: boolean;
  /** A subscription card is still running its creation handoff. */
  readonly hasPendingProvisioning: boolean;
  /** A cabinet hint — modal or toast — is on screen right now. */
  readonly hintOnScreen: boolean;
}

/**
 * The tutorial spotlights the real subscription card, so it must wait until a
 * transient creation card has handed off to its Remnawave-backed counterpart.
 *
 * …and it must not open ON TOP of a hint that is already up. Both are raised
 * by the same moment — a finished purchase — and until 21.09.2026 neither
 * knew about the other: «Готово! Подписка оформлена» drew, and the spotlight
 * then dimmed the whole page including that modal, leaving the customer two
 * overlapping things to read.
 *
 * The rule is that the tutorial goes first, and it takes both directions to
 * hold it. The hint waits for the tour in `hint-controller.tsx`; this clause
 * is the other one, for the race the hint won — the tour stays DUE (it is
 * marked seen when it starts, not when it becomes due) and starts as soon as
 * the hint is closed. See `hint-presence.ts`.
 */
export function shouldAutoStartOnboardingTour({
  pathname,
  shouldAutoStart,
  hasActiveSubscription,
  hasPendingProvisioning,
  hintOnScreen,
}: OnboardingTourAutoStartInput): boolean {
  return (
    pathname === "/dashboard" &&
    shouldAutoStart &&
    hasActiveSubscription &&
    !hasPendingProvisioning &&
    !hintOnScreen
  );
}

export interface OnboardingTourOverlayWaitInput extends OnboardingTourAutoStartInput {
  /**
   * The dashboard's subscription list has come back — with rows or without.
   * An ERROR counts as answered: the tour will not start off a failed read,
   * so nothing should wait for it either.
   */
  readonly subscriptionsAnswered: boolean;
}

/**
 * Might the tutorial still open by itself on this screen?
 *
 * Asked by anything that must not draw under it — the push prompt and the
 * cabinet hint — and deliberately WIDER than the question above.
 *
 * The difference is the whole repair. `shouldAutoStartOnboardingTour` needs
 * an active subscription, and on a fresh dashboard that answer arrives a
 * beat after the page does. In that beat the tour is not due, not pending,
 * and not anything — so a hint raised at mount sailed straight through the
 * wait and drew, and the tour then opened on top of it a moment later. That
 * is the overlap in the recording: not a tour that ignored a hint, but a
 * hint that asked whether the tour was coming before the tour could know.
 *
 * So an UNANSWERED list means «wait»: the customer has not seen the tour and
 * is on the dashboard, and that is enough to hold a hint for the fraction of
 * a second the read takes. Bounded by the query itself — rows, no rows or an
 * error all end the wait.
 *
 * `hasPendingProvisioning` is NOT treated that way, and that asymmetry is
 * deliberate: a provisioning receipt lives for 24 hours and an abandoned one
 * really does linger, so waiting on it could hold a hint for a day. The tour
 * simply starts later there, and `hintOnScreen` is what stops it landing on
 * anything.
 */
export function onboardingTourMayStillStart({
  pathname,
  shouldAutoStart,
  subscriptionsAnswered,
  hasActiveSubscription,
  hasPendingProvisioning,
  hintOnScreen,
}: OnboardingTourOverlayWaitInput): boolean {
  if (pathname !== "/dashboard" || !shouldAutoStart) return false;
  // A hint already holds the screen: the tour is not about to start, it is
  // waiting for that hint. Saying otherwise would hold the NEXT hint behind a
  // tour that is itself waiting — each for the other, for the whole visit.
  if (hintOnScreen) return false;
  if (!subscriptionsAnswered) return true;
  return hasActiveSubscription && !hasPendingProvisioning;
}

