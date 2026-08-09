/**
 * Card-effect context budget
 * ──────────────────────────
 * How many card backgrounds may hold a live GPU context at the same time, and
 * which ones get to.
 *
 * `CardEffectLayer` already refuses to mount an off-screen card: left without
 * an `active` prop it runs its own IntersectionObserver and mounts only while
 * intersecting. That is a real bound and it is why a list of cards is not a
 * list of contexts. What it is not is a CEILING — it says "as many as are on
 * screen", and how many are on screen is a function of how tall the card is and
 * how tall the device is, neither of which the layer knows.
 *
 * The subscription picker is where that bites. Its cards are ~112 px tall and
 * every one of them draws the operator's single global `cardEffect` (default
 * `aurora`, WebGL1), so a phone shows seven or eight at once and a tablet
 * twelve. `/plans` is the milder case: its cards are ~200 px and their effect is
 * per-plan opt-in, so five is the phone worst case.
 *
 * ── the number ──────────────────────────────────────────────────────────────
 * WebKit allows 16 live WebGL contexts per web-content process — not per tab,
 * and not approximately. A context leaves the pool only when its object is
 * destroyed, and the 17th request does not merely evict the oldest: it hands
 * the evicted one a `SyntheticLostContext`, which WebKit's own source marks
 * unrecoverable, so `preventDefault()` on `webglcontextlost` will not bring it
 * back. A card that loses that way is blank until it is remounted from scratch.
 *
 * Against 16, per granted card:
 *   1 renderer context, plus
 *   1 capability probe — `detectCardEffectCapabilities()` opens a real `webgl2`
 *     context and releases it through `WEBGL_lose_context`, which WebKit frees
 *     ASYNCHRONOUSLY. The layer waits a frame before mounting the renderer for
 *     exactly that reason, but on the first paint of a list every granted card
 *     probes in the same tick, so the probes overlap each other and may still
 *     be draining when the renderers arrive.
 * plus 1 for the app background, which is `active` + `keepMountedWhileHidden`
 * and therefore never gives its context back while the cabinet is open,
 * plus 1 for the dashboard carousel's SELECTED slide, which is mounted
 *   unconditionally and never asks — the queue below is first-come-first-served
 *   with no revocation, and the one card the user is looking at must not be
 *   refusable. Its warmed neighbours DO ask, so they come out of the six and
 *   add nothing here; see `useCardEffectWarmSlot`.
 *
 *   2 × 6 + 1 + 1 = 14, leaving 2 of 16 free for whatever else holds one: the
 *   outgoing screen's cards during a route transition, the landing background,
 *   the entry brand tile.
 *
 * Six is also chosen from the other end, and here the two call sites differ —
 * do not read the number as "everything visible still animates":
 *   - `/plans` on a phone fits five or six cards, so nothing that draws today
 *     stops drawing. Six is the ceiling that costs that screen nothing.
 *   - the picker on a phone fits seven or eight, so the bottom one or two keep
 *     the operator's gradient. A tablet or desktop Safari fits ten to twelve
 *     and loses more.
 * What those cards fall back to is the `NONE` appearance — a designed state,
 * the same gradient an operator gets by choosing no effect at all. That is the
 * trade the cap exists to make, and it is worth making: before it, those same
 * screens asked the process for twenty-five contexts and the ones past the
 * limit went unrecoverably black rather than gradient.
 *
 * Do NOT lower this to 1 or 2 to match the carousel. The carousel has exactly
 * one card the user is looking at; a list has all of them, and starving five of
 * six visible cards would be a redesign, not a fix.
 *
 * ── what is NOT rationed ────────────────────────────────────────────────────
 * `canvas2d` effects — 26 of the 54 in the catalog — need no GPU context at
 * all, so they are left on the layer's own IntersectionObserver exactly as they
 * are today. Rationing them would cost them visible animation to relieve
 * pressure they do not create. Same for `NONE` and for an id this bundle has no
 * component for: nothing is mounted, so nothing is claimed.
 */

import { useCallback, useEffect, useState } from "react";

import { requiresWebGL } from "@/components/reactbits/card-effect-catalog";

/** Simultaneously live card renderers. See the arithmetic above before moving. */
export const CARD_EFFECT_CONTEXT_BUDGET = 6;

type CardEffectSlotListener = (granted: boolean) => void;

interface CardEffectClaim {
  readonly notify: CardEffectSlotListener;
  granted: boolean;
}

export interface CardEffectBudget {
  readonly limit: number;
  /**
   * Ask for a slot. `notify` is called whenever the answer CHANGES, including
   * synchronously during this call if the claim is granted straight away.
   * Returns the release; calling it is not optional — a claim that is never
   * released holds a slot a scrolled-away card is no longer using, which is the
   * one way this mechanism can leave a visible card blank for ever.
   */
  claim(notify: CardEffectSlotListener): () => void;
  /** Currently granted claims. Diagnostics and tests. */
  readonly grantedCount: number;
}

/**
 * Strict first-come-first-served, and deliberately so.
 *
 * A claim that has been granted is never taken away to give a newcomer a turn.
 * Priority by "most visible" or by distance from the viewport centre would
 * re-rank the whole list on every scroll frame and tear down a renderer that
 * was drawing correctly — replacing a bounded number of contexts with an
 * unbounded number of context CREATIONS, which is the more expensive half of
 * the problem on iOS.
 */
export function createCardEffectBudget(limit: number): CardEffectBudget {
  const queue: CardEffectClaim[] = [];

  const settle = (): void => {
    let live = 0;
    for (const claim of queue) {
      const next = live < limit;
      if (next) live += 1;
      if (claim.granted === next) continue;
      claim.granted = next;
      claim.notify(next);
    }
  };

  return {
    limit,
    claim(notify) {
      const entry: CardEffectClaim = { notify, granted: false };
      queue.push(entry);
      settle();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const at = queue.indexOf(entry);
        if (at !== -1) queue.splice(at, 1);
        entry.granted = false;
        settle();
      };
    },
    get grantedCount() {
      return queue.reduce((total, claim) => total + (claim.granted ? 1 : 0), 0);
    },
  };
}

/**
 * One budget for the whole document, not one per list.
 *
 * The limit being modelled is WebKit's, and WebKit counts per web-content
 * process. A per-screen budget would let two mounted lists agree separately
 * that they were each within their means.
 */
export const cardEffectBudget = createCardEffectBudget(
  CARD_EFFECT_CONTEXT_BUDGET,
);

export interface CardEffectSlot {
  /** Attach to the card's own element — the thing whose visibility decides. */
  readonly ref: (node: Element | null) => void;
  /**
   * Pass straight to `CardEffectLayer`.
   *
   * `undefined` means "not rationed" and hands the decision back to the layer's
   * own IntersectionObserver, which is the behaviour every card had before this
   * existed. A boolean means this card is rationed and the layer must obey it.
   */
  readonly active: boolean | undefined;
}

/**
 * A card's claim on the context budget, tied to its own visibility.
 *
 * `threshold: 0.01` is not a free choice — it is the layer's own threshold, and
 * the two have to agree. This observer REPLACES the layer's for rationed
 * effects (passing `active` disables it), so a different threshold here would
 * silently move the point at which every WebGL card starts drawing.
 */
export function useCardEffectSlot(
  effect: string,
  budget: CardEffectBudget = cardEffectBudget,
): CardEffectSlot {
  const rationed = requiresWebGL(effect);
  const [node, setNode] = useState<Element | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [granted, setGranted] = useState(false);

  const ref = useCallback((next: Element | null) => setNode(next), []);

  useEffect(() => {
    if (!rationed || node === null) return;
    // No observer at all (very old engine, a non-browser render target) must
    // not mean "no card ever animates". Fall back to the pre-budget answer:
    // treat it as on screen and let the budget decide.
    if (typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setOnScreen(entry?.isIntersecting === true),
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      // Forget what the OLD observer last said. Visibility is that observer's
      // answer, not a property of the card, and the next one has not spoken
      // yet — carrying the answer over claims a slot on evidence that has been
      // thrown away. Reachable: the operator's `cardEffect` can change under a
      // mounted card, and a canvas2d value in between tears this observer down.
      setOnScreen(false);
    };
  }, [node, rationed]);

  useEffect(() => {
    if (!rationed || !onScreen) return;
    const release = budget.claim(setGranted);
    return () => {
      release();
      setGranted(false);
    };
  }, [budget, onScreen, rationed]);

  return {
    ref,
    // `onScreen` is re-checked here rather than trusted through `granted`
    // alone: the release that clears `granted` runs in an effect, one commit
    // after the card left the screen, and a card must stop drawing in the SAME
    // commit it stops being visible.
    active: rationed ? granted && onScreen : undefined,
  };
}

/**
 * A renderer kept alive for a card the user is not looking at YET.
 *
 * The carousel is the case this exists for. It hands `CardEffectLayer` an
 * explicit `active`, so only the selected slide draws and every swipe used to
 * tear one renderer down and build the next from nothing: a new GL context, a
 * new shader compile, and — since the release that made this a bug — a fresh
 * 420 ms crossfade, during which the incoming card is the operator's flat
 * gradient. Warming the immediate neighbours means a swipe finds the renderer
 * already running and already revealed, and it also stops the context CHURN,
 * which the note above calls the more expensive half of the problem on iOS: a
 * context leaves WebKit's pool only when its object is destroyed, so rapid
 * swiping creates contexts faster than they are reclaimed.
 *
 * ── why this cannot make the ceiling worse ───────────────────────────────────
 * A warm card is rationed against the SAME document-wide budget as any list, so
 * the number of simultaneously live renderers is unchanged: at most `limit`
 * from the budget, plus the carousel's own selected slide, which does not ask.
 * Warming can only take slots from other budgeted cards, never add slots.
 *
 * And the selected slide deliberately stays OUTSIDE the budget. The queue is
 * strict first-come-first-served with no revocation, so a card that asked late
 * can be refused indefinitely — acceptable for the eighth card down a list,
 * which falls back to the designed `NONE` appearance, and not acceptable for
 * the one card the user is actually looking at.
 *
 * `wanted` going false releases the claim in the same effect that took it, so
 * a neighbour that stops being a neighbour stops holding a slot; nothing keeps
 * a claim alive on a card the carousel has moved away from.
 */
export function useCardEffectWarmSlot(
  effect: string,
  wanted: boolean,
  budget: CardEffectBudget = cardEffectBudget,
): boolean {
  // Canvas effects cost no GPU context, so warming one takes nothing from the
  // budget and must not be refused by it — the same rule the picker follows.
  const rationed = requiresWebGL(effect);
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    if (!wanted || !rationed) return;
    const release = budget.claim(setGranted);
    return () => {
      release();
      setGranted(false);
    };
  }, [budget, rationed, wanted]);

  return wanted && (!rationed || granted);
}
