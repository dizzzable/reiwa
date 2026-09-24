/**
 * A cold read that must not hold its caller for longer than a budget.
 *
 * Used where nothing is held in memory yet and the caller is on a path that
 * cannot wait out a hung panel — the bot handles updates one at a time, so a
 * read that waits the transport's ten seconds stalls every chat behind it.
 *
 * The answer is the first of:
 *  - the panel's answer (`fetched`);
 *  - the saved copy, when there is one (`saved` resolving to a value): a copy
 *    in Redis is served at once rather than raced against the budget;
 *  - `null` when the budget runs out first — the caller decides what that
 *    means (its fallback).
 *
 * The read itself is not cancelled: it lands in the cache when it lands.
 */
export async function firstAnswer<T>(input: {
  readonly fetched: Promise<T>;
  /** Resolves to the saved copy, or `null` when there is none. Must not reject. */
  readonly saved?: Promise<T | null>;
  readonly budgetMs: number;
}): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), input.budgetMs);
  });
  // No saved copy → keep racing the read. Not a promise that never settles: a
  // shared one would collect a reaction per call and never release them.
  const saved =
    input.saved === undefined
      ? input.fetched
      : input.saved.then((copy) => (copy === null ? input.fetched : copy));
  try {
    return await Promise.race([input.fetched, saved, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
