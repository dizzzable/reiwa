/**
 * notification-target
 * ───────────────────
 * Pure mapping from a notification `type` to where tapping it should take the
 * user. Broadcasts / admin messages / anything unknown open the full-content
 * modal in place; actionable types route to the page where the user can act
 * (subscription expiry/limit → renewal, the traffic limit of a subscription
 * with no end date → add-ons, referral events → referral cabinet).
 */
import { connectHelpDeepLink } from '@/features/dashboard/connect-help';

export type NotificationTarget =
  | { readonly kind: 'modal' }
  | { readonly kind: 'route'; readonly path: string };

/**
 * «Помощь с подключением» — the paid notice and its twin for trials and gifts.
 * Matched EXACTLY, and first: the substring rules below were written for other
 * families, and a help message must never fall into one of them by accident.
 */
const CONNECT_HELP_TYPES: ReadonlySet<string> = new Set(['connect_help', 'connect_help_trial']);

/** «Трафик исчерпан», under both of its names (the panel's `notification-toggle.util.ts`). */
const LIMITED_TYPES: ReadonlySet<string> = new Set(['limited', 'subscription_limited']);

export function resolveNotificationTarget(
  type: string,
  /**
   * The notification's payload, when the caller has it. `subscriptionId` in it
   * names the card a connect-help notice is about; without it the dashboard
   * picks the newest subscription still waiting for help.
   */
  payload?: Record<string, unknown> | null,
): NotificationTarget {
  const t = (type ?? '').toLowerCase();

  // «Не получилось подключиться?» → the dashboard's deep link, which picks the
  // card and opens the operator's connect door — the same address a push, the
  // bot's button and the pop-up use.
  if (CONNECT_HELP_TYPES.has(t)) {
    const subscriptionId = payload?.['subscriptionId'];
    return {
      kind: 'route',
      path: connectHelpDeepLink(typeof subscriptionId === 'string' ? subscriptionId : null),
    };
  }

  // «Докупка не применена» (panel 0.9.7.70): paid, but the subscription was no
  // longer active (`addon_not_applied`) or the add-on could not be applied for
  // another reason (`addon_not_applied_other`) → support, like its
  // «💬 Поддержка» button and its push. Both only share the prefix below; that
  // subscription's add-on page has nothing for them.
  if (t === 'addon_not_applied' || t === 'addon_not_applied_other') {
    return { kind: 'route', path: '/support' };
  }

  // A paid add-on three days before it ends, or when it has (`addon_*`, all
  // six) → the add-on page on that subscription, where it is bought again —
  // the address the notice's «Купить снова» and its push open.
  if (t.startsWith('addon_')) {
    const subscriptionId = payload?.['subscriptionId'];
    return {
      kind: 'route',
      path:
        typeof subscriptionId === 'string' && subscriptionId.length > 0
          ? `/addons?subscriptionId=${encodeURIComponent(subscriptionId)}`
          : '/addons',
    };
  }

  // Support replies → the Support section so the user can open the ticket
  // and read / continue the conversation.
  if (t.includes('support')) {
    return { kind: 'route', path: '/support' };
  }

  // Referral events → the referral cabinet (who joined, rewards, etc.).
  if (t.includes('referral')) {
    return { kind: 'route', path: '/referrals' };
  }

  // «Трафик исчерпан» about a subscription with no end date → the add-on page
  // on that subscription: such a subscription is never renewed, and more
  // traffic is the way on — the address the panel gives its push and its
  // bot button (`offerTrafficTopUpForLifetime`). The notice states the expiry,
  // and `null` there is no end date; a payload without the key keeps renewal.
  // Both of the type's names, as the panel's switch knows them.
  if (
    LIMITED_TYPES.has(t) &&
    payload != null &&
    'expiresAt' in payload &&
    payload['expiresAt'] === null
  ) {
    // …unless there is nothing there to buy: no traffic add-on and no traffic
    // reset for that subscription (a lifetime one on a plan without resets,
    // say). The panel decides it when it writes the notice (`trafficTopUp:
    // false`) and leaves the bot button out; the bell shows the notice in
    // place — never an empty add-on page, nor a renewal it cannot take.
    if (payload['trafficTopUp'] === false) return { kind: 'modal' };
    const subscriptionId = payload['subscriptionId'];
    return {
      kind: 'route',
      path:
        typeof subscriptionId === 'string' && subscriptionId.length > 0
          ? `/addons?subscriptionId=${encodeURIComponent(subscriptionId)}`
          : '/addons',
    };
  }

  // Subscription expiry reminders / expired / traffic-limited → renewal page.
  if (t.includes('expir') || t.includes('limited')) {
    return { kind: 'route', path: '/renew' };
  }

  // Broadcast / admin message / generic → show the full body in a modal.
  return { kind: 'modal' };
}
