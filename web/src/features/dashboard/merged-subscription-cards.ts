/**
 * ONE CARD PER MERGED SUBSCRIPTION
 * ────────────────────────────────
 * The cabinet receives one subscription per plan of an operator bundle, but the
 * customer holds ONE product: a single link and a single device count. Two
 * cards that happen to share a URL read as two subscriptions — which is exactly
 * the thing a merged subscription was meant to stop being.
 *
 * So the dashboard draws only the card that FACES the app. The other members of
 * the group stay in the payload and keep driving the card's traffic pager
 * (`merged-subscription-traffic.ts`), their renewal/delete actions and the
 * merge service's sources — this filter is a presentation decision, not a data
 * one.
 *
 * The primary is the same one the app shows: `merge.visiblePlanId`, falling
 * back to the group's first limited plan and then to its first member — the
 * rule `resolveVisiblePlanId` applies on the server and in the traffic helper.
 *
 * Pure and total: an old panel sends no `merge`, a lone subscription groups by
 * itself, and a group with one live member is left alone.
 */
import type { Subscription } from "@/types/api";

/**
 * ONE ROW PER SOLD MERGED SUBSCRIPTION — the renewal list's own filter.
 *
 * The dashboard always draws one card per merged link, but a RENEWAL is a
 * purchase: only a subscription the panel SOLD as the bundle's tariff
 * (`merge.bundleRenewal`) is one product with one price, and only that one may be
 * renewed as a set. A customer holding two plans bought separately keeps both
 * rows — the panel prices each at its own plan and renews each on its own.
 *
 * Pure and total, like `subscriptionsShowingOneCard`.
 */
export function subscriptionsRenewingOneRow(
  subscriptions: readonly Subscription[],
): Subscription[] {
  const membersByBundle = new Map<string, Subscription[]>();
  for (const subscription of subscriptions) {
    const bundleId = subscription.merge?.bundleId;
    if (bundleId === undefined || subscription.merge?.bundleRenewal !== true) continue;
    const members = membersByBundle.get(bundleId);
    if (members === undefined) {
      membersByBundle.set(bundleId, [subscription]);
    } else {
      members.push(subscription);
    }
  }

  const primaryIdByBundle = new Map<string, string>();
  for (const [bundleId, members] of membersByBundle) {
    if (members.length < 2) continue;
    const primary = resolvePrimary(members);
    if (primary !== null) primaryIdByBundle.set(bundleId, primary.id);
  }

  return subscriptions.filter((subscription) => {
    const bundleId = subscription.merge?.bundleId;
    if (bundleId === undefined) return true;
    const primaryId = primaryIdByBundle.get(bundleId);
    return primaryId === undefined || primaryId === subscription.id;
  });
}

export function subscriptionsShowingOneCard(
  subscriptions: readonly Subscription[],
): Subscription[] {
  const membersByBundle = new Map<string, Subscription[]>();
  for (const subscription of subscriptions) {
    const bundleId = subscription.merge?.bundleId;
    if (bundleId === undefined) continue;
    const members = membersByBundle.get(bundleId);
    if (members === undefined) {
      membersByBundle.set(bundleId, [subscription]);
    } else {
      members.push(subscription);
    }
  }

  const primaryIdByBundle = new Map<string, string>();
  for (const [bundleId, members] of membersByBundle) {
    if (members.length < 2) continue;
    const primary = resolvePrimary(members);
    if (primary !== null) primaryIdByBundle.set(bundleId, primary.id);
  }

  return subscriptions.filter((subscription) => {
    const bundleId = subscription.merge?.bundleId;
    if (bundleId === undefined) return true;
    const primaryId = primaryIdByBundle.get(bundleId);
    return primaryId === undefined || primaryId === subscription.id;
  });
}

function resolvePrimary(members: readonly Subscription[]): Subscription | null {
  const first = members[0];
  if (first === undefined) return null;
  const visiblePlanId = first.merge?.visiblePlanId ?? null;
  const byVisiblePlan =
    visiblePlanId === null
      ? undefined
      : members.find((member) => member.plan?.id === visiblePlanId);
  return (
    byVisiblePlan ??
    members.find((member) => member.trafficLimit !== null) ??
    first
  );
}
