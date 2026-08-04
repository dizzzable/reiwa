/**
 * privacy-deep-link
 * ─────────────────
 * Pure decision for the `?link=` deep link that the quests dialog and the
 * trial CTA use to open a linking form on the privacy page directly.
 *
 * Two things must be decided together, which is why this is one function:
 * whether to open a sheet, and whether the param has been consumed (and so
 * should be stripped from the URL). Stripping too early on a cold branding
 * snapshot would silently swallow a valid email deep link; never stripping
 * would re-open the sheet on every close, back-nav and refresh.
 */
export type PrivacySheet = 'password' | 'telegram' | 'email';

export interface PrivacyDeepLink {
  /** Sheet to open, or `null` to leave the page as-is. */
  readonly open: PrivacySheet | null;
  /** Whether `?link=` has been acted on and must be removed from the URL. */
  readonly consumed: boolean;
}

const IGNORE: PrivacyDeepLink = { open: null, consumed: false };

export function resolvePrivacyDeepLink(
  target: string | null,
  opts: { readonly emailEnabled: boolean; readonly brandingLoading: boolean },
): PrivacyDeepLink {
  // `password` is deliberately not deep-linkable: nothing links to it, and a
  // URL that pops a password form is a phishing-shaped affordance.
  if (target !== 'telegram' && target !== 'email') return IGNORE;

  // Telegram never depends on operator config — act immediately.
  if (target === 'telegram') return { open: 'telegram', consumed: true };

  // The email row renders only once branding confirms the channel is on, and
  // `emailEnabled` starts false on a cold snapshot. Wait rather than decide.
  if (opts.brandingLoading) return IGNORE;

  // Email switched off by the operator: consume the param so the URL settles,
  // but open nothing — there is no row to open.
  if (!opts.emailEnabled) return { open: null, consumed: true };

  return { open: 'email', consumed: true };
}
