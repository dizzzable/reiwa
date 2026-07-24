export interface OnboardingTourAutoStartInput {
  readonly pathname: string;
  readonly shouldAutoStart: boolean;
  readonly hasActiveSubscription: boolean;
  /** A subscription card is still running its creation handoff. */
  readonly hasPendingProvisioning: boolean;
}

/**
 * The tutorial spotlights the real subscription card, so it must wait until a
 * transient creation card has handed off to its Remnawave-backed counterpart.
 */
export function shouldAutoStartOnboardingTour({
  pathname,
  shouldAutoStart,
  hasActiveSubscription,
  hasPendingProvisioning,
}: OnboardingTourAutoStartInput): boolean {
  return (
    pathname === "/dashboard" &&
    shouldAutoStart &&
    hasActiveSubscription &&
    !hasPendingProvisioning
  );
}
