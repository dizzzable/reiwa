/**
 * notification-target
 * ───────────────────
 * Pure mapping from a notification `type` to where tapping it should take the
 * user. Broadcasts / admin messages / anything unknown open the full-content
 * modal in place; actionable types route to the page where the user can act
 * (subscription expiry/limit → renewal, referral events → referral cabinet).
 */
export type NotificationTarget =
  | { readonly kind: 'modal' }
  | { readonly kind: 'route'; readonly path: string };

export function resolveNotificationTarget(type: string): NotificationTarget {
  const t = (type ?? '').toLowerCase();

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
