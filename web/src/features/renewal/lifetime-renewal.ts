import type { Subscription } from "@/types/api";

/**
 * A SUBSCRIPTION WITH NO END DATE IS NEITHER RENEWED NOR UPGRADED BY A PURCHASE
 * (the owner, 24.09.2026).
 *
 * The panel refuses both checkouts (`SUBSCRIPTION_IS_LIFETIME`) and changes
 * nothing for one paid anyway, so nothing here may offer either:
 *
 *  - no renewal — not the card's «Продлить», not the subscription page, not
 *    the renewal list. Where one would have been offered, the page says
 *    «Подписка бессрочная — продлевать не нужно» (`renewal.reason.lifetime`);
 *  - no upgrade — the card's «Улучшить» and the subscription page's «Улучшить
 *    план» are disabled, the upgrade page leaves such a subscription out of its
 *    list, and each says «Подписка бессрочная — сменить тариф можно только
 *    через поддержку» (`upgrade.lifetime`). An upgrade restarts the
 *    term at the payment, which would give it an end date. A trial is still
 *    upgraded: that is how a trial is left.
 *
 * Two witnesses, because neither is enough alone:
 *
 *  - the row's own date: `expiresAt: null` with no legacy `expireAt` beside it.
 *    The subscription list overlays the date the VPN panel holds, so a
 *    provisioned lifetime subscription usually arrives WITH a date — this
 *    catches the rest, and it is all an older panel gives.
 *  - the panel's word: the action policy (`lifetime`), the renewal list and the
 *    upgrade options (the `SUBSCRIPTION_IS_LIFETIME` warning), which read the
 *    subscription's own row. A panel older than the rule sends none, and then
 *    the cabinet does what it did before.
 */
export const SUBSCRIPTION_IS_LIFETIME_CODE = "SUBSCRIPTION_IS_LIFETIME";

export function isLifetimeSubscription(
  subscription: Pick<Subscription, "expiresAt" | "expireAt"> | null | undefined,
): boolean {
  if (subscription === null || subscription === undefined) return false;
  // Strictly `null`: a payload that leaves the field out says nothing about it.
  return subscription.expiresAt === null && (subscription.expireAt ?? "") === "";
}

/**
 * Whether a purchase may not change this subscription's plan: it has no end
 * date, by its row or by the panel's policy (`policyLifetime`), and it is not a
 * trial.
 */
export function isUpgradeClosedForLifetime(
  subscription: Pick<Subscription, "expiresAt" | "expireAt" | "isTrial"> | null | undefined,
  policyLifetime?: boolean,
): boolean {
  if (subscription === null || subscription === undefined) return false;
  if (subscription.isTrial === true) return false;
  return policyLifetime === true || isLifetimeSubscription(subscription);
}

/**
 * The panel's (and the BFF's) refusal of a renewal or an upgrade for a
 * subscription with no end date. One code for both: the page it answers knows
 * which it asked for.
 */
export function isLifetimeRenewalRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === SUBSCRIPTION_IS_LIFETIME_CODE
  );
}

/** Whether a list of the panel's quote warnings names a subscription with no end date. */
export function warnsLifetime(warnings: unknown): boolean {
  return (
    Array.isArray(warnings) &&
    warnings.some(
      (warning) =>
        typeof warning === "object" &&
        warning !== null &&
        (warning as { code?: unknown }).code === SUBSCRIPTION_IS_LIFETIME_CODE,
    )
  );
}
