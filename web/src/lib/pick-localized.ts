/**
 * Pick the language the reader is actually in.
 *
 * `?.ru || ?.en` is not a fallback chain, it is a preference: it returns
 * Russian whenever Russian exists, which is always, because the operator fills
 * both. Mirrors `loc()` in `quests-icon.tsx`, which got this right first.
 */
export function pickLocalized(
  text: { readonly ru?: string; readonly en?: string } | null | undefined,
  lang: string,
  fallback: string,
): string {
  if (!text) return fallback
  const preferred = lang.startsWith('ru') ? text.ru : text.en
  return preferred?.trim() || text.en?.trim() || text.ru?.trim() || fallback
}
