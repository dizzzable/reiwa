/**
 * The card-effect context budget, on its own.
 *
 * `card-effect-context-budget.test.tsx` is the one that renders real cards and
 * counts real renderers. This file is the arithmetic underneath it: who gets a
 * slot, in what order, and what happens when one is given back. Kept separate
 * and out of jsdom because the queue is the part a future change is most likely
 * to "simplify" — and because a set-based or LIFO rewrite still passes a test
 * that only counts how many claims were granted.
 *
 * The one thing this file cannot check is that six is the right number for a
 * real device. What it CAN check is the arithmetic that produced six, which is
 * the first assertion below.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CARD_EFFECT_CONTEXT_BUDGET,
  createCardEffectBudget,
} from "../src/lib/card-effect-budget";

/**
 * WebKit's ceiling, per web-content process. Written here as a literal on
 * purpose: if the budget is ever raised, this file is where the raise has to
 * argue with the platform.
 */
const WEBKIT_LIVE_WEBGL_CONTEXTS = 16;

/** Always-mounted, `keepMountedWhileHidden`, never released while the app is open. */
const APP_BACKGROUND_CONTEXTS = 1;

describe("the size of the budget", () => {
  it("leaves room for every card's capability probe AND the app background", () => {
    // Each granted card can hold TWO contexts at once for a frame: the
    // `webgl2` probe `detectCardEffectCapabilities()` opens and releases
    // asynchronously, and the renderer that mounts one frame later. On the
    // first paint of a list every granted card probes in the same tick.
    const peak =
      CARD_EFFECT_CONTEXT_BUDGET * 2 + APP_BACKGROUND_CONTEXTS;

    expect(
      peak,
      `a budget of ${CARD_EFFECT_CONTEXT_BUDGET} cards peaks at ${peak} live WebGL ` +
        `contexts (renderer + capability probe each, plus the app background), and ` +
        `WebKit allows ${WEBKIT_LIVE_WEBGL_CONTEXTS} per web-content process. The ` +
        `context evicted at the limit gets an unrecoverable SyntheticLostContext, ` +
        `so the card it belonged to stays blank until it is remounted.`,
    ).toBeLessThanOrEqual(WEBKIT_LIVE_WEBGL_CONTEXTS);
  });

  it("keeps real headroom rather than sitting exactly on the limit", () => {
    // A route transition can have the outgoing screen's cards still mounted
    // while the incoming screen's mount, and the landing background and the
    // entry brand tile each hold one. Exactly-16 is not a budget, it is a bet.
    const peak = CARD_EFFECT_CONTEXT_BUDGET * 2 + APP_BACKGROUND_CONTEXTS;

    expect(
      WEBKIT_LIVE_WEBGL_CONTEXTS - peak,
      "the budget must leave spare contexts for layers that are not cards",
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("handing slots out", () => {
  it("grants every claim up to the limit", () => {
    const budget = createCardEffectBudget(3);
    const answers = [vi.fn(), vi.fn(), vi.fn()];
    for (const answer of answers) budget.claim(answer);

    expect(
      budget.grantedCount,
      "the budget refused a claim it had room for — cards go unanimated while " +
        "slots sit unused, which is the cap being a bug rather than a bound",
    ).toBe(3);
    for (const answer of answers) {
      expect(
        answer,
        "a claim was granted without being TOLD. The card is waiting on that " +
          "call for its state update, so a silent grant is an unanimated card " +
          "holding a slot nobody can use",
      ).toHaveBeenCalledWith(true);
    }
  });

  it("refuses the claim past the limit, and says so instead of staying silent", () => {
    const budget = createCardEffectBudget(2);
    budget.claim(vi.fn());
    budget.claim(vi.fn());
    const third = vi.fn();
    budget.claim(third);

    expect(
      budget.grantedCount,
      "a third card was granted a slot in a budget of two — the cap is not capping",
    ).toBe(2);
    // Not merely "was not called with true": a claim that is never answered at
    // all leaves the card waiting on a state update that never arrives.
    expect(
      third,
      "the claim that overran the limit was told it could draw — the cap counts " +
        "correctly and then hands out a slot it does not have",
    ).not.toHaveBeenCalledWith(true);
  });

  it("never revokes a granted slot to make room for a newcomer", () => {
    // Re-ranking on every scroll frame would trade a bounded number of live
    // contexts for an unbounded number of context CREATIONS, which is the more
    // expensive half of the problem on iOS.
    const budget = createCardEffectBudget(1);
    const first = vi.fn();
    budget.claim(first);
    first.mockClear();

    budget.claim(vi.fn());

    expect(
      first,
      "an already-drawing card was told to stop so a newer claim could draw",
    ).not.toHaveBeenCalled();
    expect(budget.grantedCount).toBe(1);
  });
});

describe("giving a slot back", () => {
  it("promotes the longest-waiting claim, so a scrolled-to card can draw", () => {
    const budget = createCardEffectBudget(1);
    const release = budget.claim(vi.fn());
    const waitingFirst = vi.fn();
    const waitingSecond = vi.fn();
    budget.claim(waitingFirst);
    budget.claim(waitingSecond);

    release();

    expect(
      waitingFirst,
      "releasing a slot did not hand it to the card that had been waiting longest — " +
        "a card scrolled back into view can be left permanently without artwork",
    ).toHaveBeenCalledWith(true);
    expect(
      waitingSecond,
      "the freed slot went to the NEWER of the two waiting claims. On a scroll " +
        "that is the card furthest from where the user is looking, and the one " +
        "they scrolled to stays blank",
    ).not.toHaveBeenCalledWith(true);
    expect(budget.grantedCount).toBe(1);
  });

  it("returns the slot to the pool when the holder is the one that leaves", () => {
    const budget = createCardEffectBudget(2);
    const release = budget.claim(vi.fn());
    budget.claim(vi.fn());
    expect(budget.grantedCount).toBe(2);

    release();

    expect(
      budget.grantedCount,
      "a released claim is still counted against the budget — every scroll " +
        "permanently shrinks how many cards may animate",
    ).toBe(1);
  });

  it("drops a waiting claim without disturbing anyone who is drawing", () => {
    const budget = createCardEffectBudget(1);
    const holder = vi.fn();
    budget.claim(holder);
    holder.mockClear();
    const releaseWaiting = budget.claim(vi.fn());

    releaseWaiting();

    expect(
      holder,
      "a card that was drawing was told to stop because an unrelated card that " +
        "had never drawn scrolled away — the list flickers on every scroll",
    ).not.toHaveBeenCalled();
    expect(budget.grantedCount).toBe(1);
  });

  it("survives being released twice", () => {
    // React can run an effect cleanup after the component is already gone, and
    // StrictMode runs mount/cleanup/mount in development. A second release that
    // removed someone ELSE's slot would show up as cards going dark at random.
    const budget = createCardEffectBudget(2);
    const release = budget.claim(vi.fn());
    budget.claim(vi.fn());

    release();
    release();

    expect(
      budget.grantedCount,
      "a second release took a slot that belonged to someone else. React runs " +
        "mount/cleanup/mount in StrictMode and can run a cleanup after the " +
        "component is already gone, so this happens in development on every " +
        "card — it looks like cards going dark at random",
    ).toBe(1);
  });
});
