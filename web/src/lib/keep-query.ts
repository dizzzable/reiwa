/**
 * Carry acquisition parameters across a client-side navigation.
 *
 * ── Why this exists in a file of its own ─────────────────────────────────
 *
 * React-router replaces the whole URL, query included, when a `Link` is given
 * a bare path. Everything that identifies where a visitor came from lives in
 * that query — the `utm_*` tags the register form reads off
 * `window.location.search`, the `?campaign=ad_<code>` marker, a `ref` token —
 * so a single bare `to="/register"` between the ad and the form silently ends
 * the attribution.
 *
 * That is not hypothetical. The home page fixed it locally and kept its own
 * copy of this function; the landing page's four call-to-action buttons and
 * the sign-in page's "create an account" link kept the bare paths, and those
 * are the routes an actual advertisement leads down. The result an operator
 * saw was «UTM-метки для этого пользователя не сохранены» on every single
 * profile — the tags were captured by the server, dropped by the browser one
 * hop before the form, and read back as never having existed.
 *
 * One copy, so the next page cannot be fixed and the one beside it forgotten.
 */

/**
 * Non-`utm_` parameters worth carrying.
 *
 * `ref` is a referral token and `next` is where the visitor was going before
 * a gate interrupted them; losing either breaks something a person can see.
 */
const CARRIED_PARAMS = ['ref', 'next', 'campaign', 'startapp'] as const;

/**
 * Append the carried parameters of the CURRENT url to a navigation target.
 *
 * A target that already carries its own query is returned untouched — it was
 * built deliberately, and merging into it would be guessing.
 */
export function keepQuery(target: string): string {
  if (target.includes('?')) return target;
  if (typeof window === 'undefined') return target;

  const carried = new URLSearchParams();
  const current = new URLSearchParams(window.location.search);
  for (const [key, value] of current) {
    if (key.startsWith('utm_') || (CARRIED_PARAMS as readonly string[]).includes(key)) {
      carried.set(key, value);
    }
  }
  const query = carried.toString();
  return query.length > 0 ? `${target}?${query}` : target;
}
