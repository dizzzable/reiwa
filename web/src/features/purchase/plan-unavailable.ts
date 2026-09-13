/**
 * A plan the panel no longer sells, met mid-checkout.
 *
 * The catalogue a subscriber picks from can be stale — the service worker and
 * React Query both keep it — so an operator can archive or delete a plan that
 * is still on their screen. rezeis refuses that checkout before any draft or
 * charge exists, and the BFF forwards the refusal as `400 { code }`
 * (`src/api/routes/payments-errors.ts`). Purchase, upgrade and renewal all
 * answer it the same way: say so, drop the stale list, and go back to choosing.
 */
import { toast } from "sonner";

/**
 * The panel's code for a checkout whose quote is no longer purchasable — in
 * practice, a plan or term withdrawn after the subscriber chose it.
 */
export const PLAN_UNAVAILABLE_REFUSAL_CODE = "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE";

/** True for the BFF's forwarded refusal. Reads the code only, never the message. */
export function isPlanUnavailableRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === PLAN_UNAVAILABLE_REFUSAL_CODE
  );
}

/**
 * A toast, not a dialog: every caller moves the subscriber onto a list that no
 * longer shows the plan, so the screen they land on carries the rest.
 */
export function notifyPlanUnavailable(t: (key: string) => string): void {
  toast.warning(t("purchase.checkout.planUnavailable"), { duration: 5_000 });
}
