/**
 * notification-target
 * ───────────────────
 * Pure mapping from a notification `type` to where tapping it should take the
 * user. Broadcasts / admin messages / anything unknown open the full-content
 * modal in place; actionable types route to the page where the user can act
 * (subscription expiry/limit → renewal, referral events → referral cabinet).
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

  // Subscription expiry reminders / expired / traffic-limited → renewal page.
  if (t.includes('expir') || t.includes('limited')) {
    return { kind: 'route', path: '/renew' };
  }

  // Broadcast / admin message / generic → show the full body in a modal.
  return { kind: 'modal' };
}
