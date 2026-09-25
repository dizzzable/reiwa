/**
 * A read of a settings group in the cabinet's API that has nothing to serve
 * but what the panel answers: the panel's answer, or — when the panel has not
 * answered within a head start — the copy saved in reiwa's Redis, while the
 * panel read goes on and lands in the cache when it comes.
 *
 * The API's readers (the landing, the appearance and its emoji packs, the
 * connect screen, the guest chat's config) used to ask for the copy only once
 * the panel read had failed. With a panel that HANGS — its VPS down, packets
 * dropped rather than refused — that is the transport's ten seconds, and the
 * first visitors after a restart waited them all with the copy sitting in
 * Redis (the bot's caches had the same defect, review R3b-02).
 *
 * Why a head start, and not the copy at once as the bot's caches serve it: a
 * cold read here also follows every operator's save — the invalidate webhook
 * drops the cache — and then the panel is up and has the change, while the copy
 * is the version from before it. The panel gets {@link PANEL_HEAD_START_MS},
 * ample for a panel that answers; only one that does not is stood in for.
 *
 * What stands in (`instead`), as the store answers it:
 *  - a copy: served; the caller's `instead` holds it like an answer gone stale,
 *    and the panel's answer replaces it when it lands;
 *  - `null`, none: the panel read is waited for, as before — there is nothing
 *    to stand in with;
 *  - unreadable: not "none" — asked again after the store's pause, for as long
 *    as the panel read is out, and never remembered (review R2a-01).
 * An answer the panel gives while Redis is asked wins over the copy.
 */
import {
  LAST_KNOWN_GOOD_RETRY_MS,
  LAST_KNOWN_GOOD_UNREADABLE,
  type LastKnownGoodUnreadable,
} from './last-known-good.js';
import { settlesWithin } from './within-budget.js';

/**
 * How long the panel is waited for before the saved copy is served in its
 * place: a second, the budget of the bot's cold reads
 * (`bot/lib/config-within.ts`) — far above the round trip of a panel that
 * answers, far below the transport's ten seconds.
 */
export const PANEL_HEAD_START_MS = 1_000;

export async function panelOrSavedCopy<T>(opts: {
  /** The read of the panel that is out — what the caller would have waited for. */
  readonly panel: Promise<T>;
  /** One read of what stands in — the saved copy. Must not reject. */
  readonly instead: () => Promise<T | null | LastKnownGoodUnreadable>;
  readonly headStartMs?: number;
  /** How long after an unreadable answer to ask again: the store's pause. */
  readonly retryMs?: number;
}): Promise<T> {
  const { panel } = opts;
  if (await settlesWithin(panel, opts.headStartMs ?? PANEL_HEAD_START_MS)) return panel;
  let landed = false;
  const mark = (): void => {
    landed = true;
  };
  void panel.then(mark, mark);
  for (;;) {
    const copy = await opts.instead();
    if (landed || copy === null) return panel;
    if (copy !== LAST_KNOWN_GOOD_UNREADABLE) return copy;
    if (await settlesWithin(panel, opts.retryMs ?? LAST_KNOWN_GOOD_RETRY_MS)) return panel;
  }
}
