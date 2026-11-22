/**
 * The traffic of ONE merged subscription card.
 * ─────────────────────────────────────────────
 * A customer who holds two or more plans of one operator bundle gets ONE merged
 * subscription link, and the cabinet draws ONE card for it. The card's own
 * traffic row belongs to the plan the app faces; nothing is printed under it —
 * the second tariff line («0.01 / 50 ГБ») was removed on the owner's word
 * (14.11.2026): «в вебаппе второй тариф пусть не показывается».
 *
 * One fact the card needs from the group:
 *
 *  - DOES THE BUNDLE HOLD AN UNLIMITED PLAN? Then the card's own row says
 *    «Трафик ∞»: that is what the customer bought, and «Безлимит» is the sign
 *    the shop sells it by («в карточке тарифа при покупке если в объединённых
 *    тарифах есть безлимит, в карточке должен указывать он»).
 *
 * Pure and total: an old panel sends no `merge`, one subscription on its own
 * groups by itself, and anything unreadable simply produces no entry.
 */
import type { Subscription } from "@/types/api";

/** What the merged card needs to know beyond its own subscription row. */
export interface MergedCardTraffic {
  /** The bundle holds an unlimited plan, so the card's own row says «Трафик ∞». */
  readonly hasUnlimited: boolean;
}

export type MergedCardTrafficBySubscriptionId = Readonly<Record<string, MergedCardTraffic>>;

/**
 * subscription id → what the card prints instead of its own traffic row.
 *
 * Only the group's PRIMARY card gets an entry: the primary is the plan the app
 * shows (`merge.visiblePlanId`), falling back to the group's first limited plan
 * and then to its first member — the same rule the admin panel applies to a
 * bundle, so the cabinet and the app agree on whose face is shown.
 */
export function mergedCardTrafficBySubscriptionId(
  subscriptions: readonly Subscription[],
): MergedCardTrafficBySubscriptionId {
  const groups = new Map<string, Subscription[]>();
  for (const subscription of subscriptions) {
    // A DELETED member is not a plan of the product any more: the bot filters
    // the same way before it groups a bundle, so both faces agree.
    if (subscription.status === "DELETED") continue;
    const bundleId = subscription.merge?.bundleId;
    if (bundleId === undefined) continue;
    const members = groups.get(bundleId);
    if (members === undefined) {
      groups.set(bundleId, [subscription]);
    } else {
      members.push(subscription);
    }
  }

  const trafficById: Record<string, MergedCardTraffic> = {};
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const primary = resolvePrimary(members);
    if (primary === null) continue;
    trafficById[primary.id] = {
      hasUnlimited: members.some((member) => member.trafficLimit === null),
    };
  }
  return trafficById;
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
