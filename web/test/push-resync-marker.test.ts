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
  rememberPushResync,
  watchForPushResyncFailure,
} from "@/lib/push-resync-marker";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "serviceWorker");
  vi.restoreAllMocks();
});

describe("the tab's `already healed` marker", () => {
  it("holds for a heal that has just happened", () => {
    rememberPushResync();

    expect(isPushResyncFresh()).toBe(true);
  });

  it("stops holding once it is old enough", () => {
    const at = Date.now() - PUSH_RESYNC_MAX_AGE_MS - 1;
    rememberPushResync(at);

    expect(
      isPushResyncFresh(),
      "a marker written this morning still suppresses the heal tonight, so a tab whose subscription broke in between never repairs it",
    ).toBe(false);
  });

  it("does not hold for a stamp from the future", () => {
    // A clock that moved backwards would otherwise pin the marker open for as
    // long as the skew lasts — the same "for ever" this file exists to remove.
    rememberPushResync(Date.now() + 60 * 60 * 1000);

    expect(isPushResyncFresh()).toBe(false);
  });

  it("treats the value written by an older build as absent", () => {
    // A tab upgraded mid-session carries the legacy `"1"`. Reading it as fresh
    // would carry the defect straight through the deploy that fixes it.
    sessionStorage.setItem(PUSH_RESYNC_KEY, "1");

    expect(isPushResyncFresh()).toBe(false);
  });

  it("treats anything unparseable as absent, rather than throwing", () => {
    sessionStorage.setItem(PUSH_RESYNC_KEY, "{not json");

    expect(isPushResyncFresh()).toBe(false);
  });

  it("is retracted by hand", () => {
    rememberPushResync();
    forgetPushResync();

    expect(isPushResyncFresh()).toBe(false);
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
    rememberPushResync();

    target.dispatchEvent(
      new MessageEvent("message", {
        data: { type: PUSH_RESYNC_FAILED_MESSAGE, status: 401, endpoint: "https://push/new" },
      }),
    );

    expect(
      isPushResyncFresh(),
      "the worker knew push had stopped and the page went on believing itself healed",
    ).toBe(false);
  });

  it("ignores every other message the worker sends", () => {
    // The same channel carries the strategy-violation report. Clearing on
    // anything at all would make the marker meaningless.
    const target = withServiceWorker();
    watchForPushResyncFailure();
    rememberPushResync();

    target.dispatchEvent(
      new MessageEvent("message", { data: { type: "STRATEGY_VIOLATION", message: "x" } }),
    );
    target.dispatchEvent(new MessageEvent("message", { data: undefined }));

    expect(isPushResyncFresh()).toBe(true);
  });

  it("does nothing where there is no service worker at all", () => {
    expect(() => watchForPushResyncFailure()).not.toThrow();
  });
});
