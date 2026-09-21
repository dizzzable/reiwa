// @vitest-environment jsdom

/**
 * "ALREADY HEALED" MUST EXPIRE, AND MUST BE RETRACTABLE.
 *
 * The marker was the string `"1"` in `sessionStorage`, which survives reloads
 * and `location.replace` for the whole life of a browsing context. It therefore
 * meant "once per TAB" — and a pinned tab lives for weeks, during which push
 * can break underneath it:
 *
 *   09:00  the tab heals; the marker stands.
 *   the next day the session lapses. The browser fires
 *          `pushsubscriptionchange`; the worker mints a new subscription and
 *          POSTs it; the POST answers 401. The old endpoint is gone and the
 *          server never learned the new one.
 *   the customer reloads and signs in — the marker still says done, the heal is
 *          skipped, and push is dead in that tab for as long as it lives.
 *
 * Two independent repairs, and this file holds both: the marker EXPIRES, so no
 * wrong answer can stand for longer than a few hours whatever caused it; and
 * the worker can RETRACT it the moment it knows the registration was refused,
 * which closes the case above on the very next session change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PUSH_RESYNC_FAILED_MESSAGE,
  PUSH_RESYNC_KEY,
  PUSH_RESYNC_MAX_AGE_MS,
  forgetPushResync,
  isPushResyncFresh,
  pushResyncAccountKey,
  rememberPushResync,
  watchForPushResyncFailure,
} from "@/lib/push-resync-marker";

/** The signed-in account a heal is recorded for. */
const ACCOUNT = "usr_the_one_signed_in";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "serviceWorker");
  vi.restoreAllMocks();
});

describe("the tab's `already healed` marker", () => {
  it("holds for a heal that has just happened", () => {
    rememberPushResync(ACCOUNT);

    expect(isPushResyncFresh(ACCOUNT)).toBe(true);
  });

  it("stops holding once it is old enough", () => {
    const at = Date.now() - PUSH_RESYNC_MAX_AGE_MS - 1;
    rememberPushResync(ACCOUNT, at);

    expect(
      isPushResyncFresh(ACCOUNT),
      "a marker written this morning still suppresses the heal tonight, so a tab whose subscription broke in between never repairs it",
    ).toBe(false);
  });

  it("does not hold for a stamp from the future", () => {
    // A clock that moved backwards would otherwise pin the marker open for as
    // long as the skew lasts — the same "for ever" this file exists to remove.
    rememberPushResync(ACCOUNT, Date.now() + 60 * 60 * 1000);

    expect(isPushResyncFresh(ACCOUNT)).toBe(false);
  });

  it("treats the value written by an older build as absent", () => {
    // A tab upgraded mid-session carries the legacy `"1"`. Reading it as fresh
    // would carry the defect straight through the deploy that fixes it.
    sessionStorage.setItem(PUSH_RESYNC_KEY, "1");

    expect(isPushResyncFresh(ACCOUNT)).toBe(false);
  });

  it("treats anything unparseable as absent, rather than throwing", () => {
    sessionStorage.setItem(PUSH_RESYNC_KEY, "{not json");

    expect(isPushResyncFresh(ACCOUNT)).toBe(false);
  });

  it("is retracted by hand", () => {
    rememberPushResync(ACCOUNT);
    forgetPushResync();

    expect(isPushResyncFresh(ACCOUNT)).toBe(false);
  });

  it("does not answer for a DIFFERENT account, however young it is", () => {
    // THE DEFECT, stated as a test. One browser, two people: a shared test
    // device, a household, one phone carrying two subscriptions. The endpoint
    // belongs to the browser and the row belongs to an account, and only a
    // heal binds the two — so a marker left by whoever signed in first used to
    // refuse the next account a heal for six hours. Their pushes went to the
    // previous account, the settings switch read "on" because the browser did
    // hold a subscription, and there was nothing left to switch on.
    rememberPushResync("usr_whoever_was_here_before");

    expect(isPushResyncFresh(ACCOUNT)).toBe(false);
  });

  it("treats a marker with no account as absent", () => {
    // ANTI-VACUITY for the case above AND the upgrade path: a tab carrying a
    // marker from the build before this one must heal once, not carry the
    // defect through the deploy that fixes it.
    sessionStorage.setItem(PUSH_RESYNC_KEY, JSON.stringify({ at: Date.now() }));

    expect(isPushResyncFresh(ACCOUNT)).toBe(false);
  });

  it("still holds for the SAME account, so an ordinary tab heals once", () => {
    // ANTI-VACUITY the other way. "Never fresh" would pass every case above
    // and re-register the endpoint on every session change, against the per-IP
    // budget every customer behind one NAT shares.
    rememberPushResync(ACCOUNT);

    expect(isPushResyncFresh(ACCOUNT)).toBe(true);
  });
});

describe("which account a heal is recorded for", () => {
  it("prefers the canonical reiwa id", () => {
    expect(pushResyncAccountKey({ id: "usr_abc", telegramId: "777" })).toBe("usr_abc");
  });

  it("falls back to the Telegram id, tagged so it can never collide with a cuid", () => {
    expect(pushResyncAccountKey({ telegramId: "777" })).toBe("tg:777");
  });

  it("answers the empty string for a session that identifies nobody", () => {
    // Which `readMarker` refuses, so the heal runs every time rather than
    // being skipped on a marker that could belong to anyone.
    expect(pushResyncAccountKey(null)).toBe("");
    expect(pushResyncAccountKey({ telegramId: null })).toBe("");
    expect(pushResyncAccountKey({ id: "   " })).toBe("");
  });

  it("does not let an unidentifiable session read a stored marker as its own", () => {
    rememberPushResync(ACCOUNT);

    expect(isPushResyncFresh(pushResyncAccountKey(null))).toBe(false);
  });
});

describe("the worker's report that a re-registration was refused", () => {
  function withServiceWorker(): EventTarget {
    const target = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { value: target, configurable: true });
    return target;
  }

  it("retracts the marker, so the next session change heals", () => {
    const target = withServiceWorker();
    watchForPushResyncFailure();
    rememberPushResync(ACCOUNT);

    target.dispatchEvent(
      new MessageEvent("message", {
        data: { type: PUSH_RESYNC_FAILED_MESSAGE, status: 401, endpoint: "https://push/new" },
      }),
    );

    expect(
      isPushResyncFresh(ACCOUNT),
      "the worker knew push had stopped and the page went on believing itself healed",
    ).toBe(false);
  });

  it("ignores every other message the worker sends", () => {
    // The same channel carries the strategy-violation report. Clearing on
    // anything at all would make the marker meaningless.
    const target = withServiceWorker();
    watchForPushResyncFailure();
    rememberPushResync(ACCOUNT);

    target.dispatchEvent(
      new MessageEvent("message", { data: { type: "STRATEGY_VIOLATION", message: "x" } }),
    );
    target.dispatchEvent(new MessageEvent("message", { data: undefined }));

    expect(isPushResyncFresh(ACCOUNT)).toBe(true);
  });

  it("does nothing where there is no service worker at all", () => {
    expect(() => watchForPushResyncFailure()).not.toThrow();
  });
});
