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
  return mergeCarriedQuery(target);
}

/**
 * Merge the carried parameters into a target that ALREADY has a query.
 *
 * Where `keepQuery` steps aside for such a target, this one folds into it, and
 * anything the target set itself wins. That distinction is the whole reason
 * both exist: a target built by hand is usually deliberate, but `/bootstrap`
 * rebuilds its destination from `?next=` ALONE, so every `utm_*` beside it was
 * dropped on the one hop that unwraps a deep link — the placement recorded,
 * the tags gone, and a profile that reads as though the marks never existed.
 */
export function mergeCarriedQuery(target: string): string {
  if (typeof window === 'undefined') return target;

  const questionMark = target.indexOf('?');
  const path = questionMark === -1 ? target : target.slice(0, questionMark);
  const merged = new URLSearchParams(questionMark === -1 ? '' : target.slice(questionMark + 1));

  const current = new URLSearchParams(window.location.search);
  for (const [key, value] of current) {
    // Whatever the target already decided stays decided — `next` in particular
    // arrives here sanitised, and the raw one must not overwrite it.
    if (merged.has(key)) continue;
    if (key.startsWith('utm_') || (CARRIED_PARAMS as readonly string[]).includes(key)) {
      merged.set(key, value);
    }
  }
  const query = merged.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}
