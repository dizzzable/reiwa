import type { Subscription } from "@/types/api";

/**
 * How a subscription names itself to the person who owns it.
 *
 * ── Why this is one function and not four ────────────────────────────────────
 *
 * The same three-step chain was written out separately in the dashboard's
 * select card, the delete dialog and the renewal page — three places that all
 * answer one question ("which subscription is this?") and all have to answer it
 * the same way, because a customer holding several sees them side by side. The
 * connect screen was about to be the fourth copy.
 *
 * That is the shape this codebase has been bitten by before: an identical rule
 * duplicated across files, then quietly amended in one of them. Nothing fails
 * when they drift — the customer simply sees one subscription called two
 * different things and has no way to tell it is the same one.
 *
 * ── The order is the point ───────────────────────────────────────────────────
 *
 * The Remnawave PROFILE NAME comes first, because that is the string the
 * customer is being asked to recognise: it is what the connect screen is about
 * to install, and what their VPN client will show them afterwards. The plan name
 * is second — useful, but two subscriptions on one plan share it, so it cannot
 * be the primary answer. The id is last: unreadable, but it is at least unique,
 * and a subscription that names itself with nothing at all cannot be told apart
 * from the one beside it.
 *
 * `||` rather than `??` on purpose. An empty string is a name in neither of the
 * first two slots, and `??` would let one through and render a blank label.
 *
 * ── Not for every list ───────────────────────────────────────────────────────
 *
 * The promo and points-exchange screens deliberately put the PLAN first: those
 * lists are about what a subscription entitles you to, not about which of your
 * subscriptions it is. They are not copies of this that drifted.
 */
export function subscriptionTitle(sub: Subscription): string {
  return sub.profileName || sub.plan?.name || sub.id;
}
