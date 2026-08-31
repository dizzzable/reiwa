/**
 * The two decisions a traffic-reset add-on forces on the cabinet, kept out of
 * the page so they can be tested where they are actually made.
 *
 * A reset is the only add-on that can be taken WITHOUT a checkout, and the only
 * one whose price depends on how many times it has already been taken. Both
 * facts are decided by the backend and merely rendered here — the shapes below
 * are deliberately structural (not the API type) so this module stays a pure
 * function of what the server said.
 */

export interface ResetTrafficAddOnView {
  readonly type: string;
  readonly freeAllowance?: {
    readonly freeUsesPerTerm: number;
    readonly freeRemaining: number;
    readonly isFree: boolean;
  } | null;
}

/**
 * True while this add-on is a traffic reset the operator's allowance still
 * covers.
 *
 * `isFree` is the server's own verdict and is trusted as-is rather than
 * recomputed from `freeRemaining`: the two can legitimately disagree (an
 * operator who sets the allowance to zero mid-term leaves customers with
 * remaining uses the server no longer honours), and in that disagreement the
 * server is right. A missing `freeAllowance` — a cabinet newer than the API it
 * is talking to — falls back to "not free", so the worst outcome is a price
 * shown where none was due, never a charge skipped.
 */
export function isFreeResetTraffic(addOn: ResetTrafficAddOnView): boolean {
  return addOn.type === 'RESET_TRAFFIC' && addOn.freeAllowance?.isFree === true;
}

/**
 * Which of the two paths picking this add-on opens.
 *
 * `FREE_RESET` skips the wizard entirely: no gateway to choose, no transaction
 * to review, so the confirmation dialog IS the flow. `CHECKOUT` is every other
 * case, including a PAID reset, which is bought exactly like extra traffic.
 */
export function resolveAddOnPickPath(addOn: ResetTrafficAddOnView): 'FREE_RESET' | 'CHECKOUT' {
  return isFreeResetTraffic(addOn) ? 'FREE_RESET' : 'CHECKOUT';
}

/**
 * How many free resets remain AFTER the one being confirmed is taken.
 *
 * Shown in the confirmation so the decision is made with the cost in view.
 * Clamped at zero: a server that reports a remaining count of zero while still
 * calling the reset free (allowance changed under a stale page) must not
 * produce "-1 free resets left".
 */
export function freeResetsLeftAfter(addOn: ResetTrafficAddOnView): number {
  const remaining = addOn.freeAllowance?.freeRemaining ?? 0;
  return Math.max(0, remaining - 1);
}
