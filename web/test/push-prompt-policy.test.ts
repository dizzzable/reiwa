// @vitest-environment jsdom

/**
 * The push prompt's decisions and its memory, without the card.
 *
 *   - Eligible: marked in THIS tab within the last 30 minutes (sessionStorage).
 *   - Shown: ever, in THIS browser profile (localStorage) — any value counts.
 *   - Storage that throws (a private window, blocked site data) must not crash
 *     anything, and must not turn "once" into "every time" within a page.
 *   - The synchronous conditions, cheapest first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mustWaitForTour,
  pushPromptRefusal,
  type PushPromptEnvironment,
} from "@/features/push-prompt/push-prompt-policy";
import {
  clearPushPromptEligibility,
  isPushPromptEligible,
  markPushPromptEligible,
  PUSH_PROMPT_ELIGIBLE_KEY,
  PUSH_PROMPT_ELIGIBLE_TTL_MS,
  PUSH_PROMPT_RECORD_KEY,
  readPushPromptRecord,
  resetPushPromptMemoryForTests,
  wasPushPromptShown,
  writePushPromptRecord,
} from "@/features/push-prompt/push-prompt-storage";

const NOW = Date.parse("2026-09-19T10:00:00.000Z");
const MINUTE = 60_000;

function throwingStorage(): Storage {
  const refuse = (): never => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    get length(): number {
      return refuse();
    },
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetPushPromptMemoryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("eligibility — this tab, 30 minutes", () => {
  it("is 30 minutes, by the literal", () => {
    expect(PUSH_PROMPT_ELIGIBLE_TTL_MS).toBe(30 * MINUTE);
  });

  it("holds from the mark to the thirtieth minute, and not a millisecond after", () => {
    expect(isPushPromptEligible(NOW)).toBe(false);
    markPushPromptEligible(NOW);
    expect(window.sessionStorage.getItem(PUSH_PROMPT_ELIGIBLE_KEY)).toBe(JSON.stringify({ at: NOW }));
    expect(isPushPromptEligible(NOW)).toBe(true);
    expect(isPushPromptEligible(NOW + 30 * MINUTE)).toBe(true);
    expect(isPushPromptEligible(NOW + 30 * MINUTE + 1)).toBe(false);
  });

  it("is gone once cleared", () => {
    markPushPromptEligible(NOW);
    clearPushPromptEligibility();
    expect(isPushPromptEligible(NOW)).toBe(false);
  });

  it("ignores a mark from far in the future and one it cannot read", () => {
    window.sessionStorage.setItem(PUSH_PROMPT_ELIGIBLE_KEY, JSON.stringify({ at: NOW + 60 * MINUTE }));
    expect(isPushPromptEligible(NOW)).toBe(false);
    window.sessionStorage.setItem(PUSH_PROMPT_ELIGIBLE_KEY, "{not json");
    expect(isPushPromptEligible(NOW)).toBe(false);
    window.sessionStorage.setItem(PUSH_PROMPT_ELIGIBLE_KEY, JSON.stringify({ at: "now" }));
    expect(isPushPromptEligible(NOW)).toBe(false);
  });

  it("survives a sessionStorage that throws, for the life of the page", () => {
    vi.spyOn(window, "sessionStorage", "get").mockReturnValue(throwingStorage());
    expect(() => markPushPromptEligible(NOW)).not.toThrow();
    expect(isPushPromptEligible(NOW)).toBe(true);
    expect(() => clearPushPromptEligibility()).not.toThrow();
    expect(isPushPromptEligible(NOW)).toBe(false);
  });
});

describe("the record — this browser profile, once", () => {
  it("is absent until written, and any value there means shown", () => {
    expect(wasPushPromptShown()).toBe(false);
    window.localStorage.setItem(PUSH_PROMPT_RECORD_KEY, "garbage from an older build");
    expect(wasPushPromptShown()).toBe(true);
  });

  it("keeps how it ended", () => {
    writePushPromptRecord("shown", NOW);
    expect(readPushPromptRecord()).toEqual({ state: "shown", at: NOW });
    writePushPromptRecord("dismissed", NOW + MINUTE);
    expect(JSON.parse(window.localStorage.getItem(PUSH_PROMPT_RECORD_KEY)!)).toEqual({
      state: "dismissed",
      at: NOW + MINUTE,
    });
  });

  it("falls back to memory when localStorage throws: no crash, and still once", () => {
    vi.spyOn(window, "localStorage", "get").mockReturnValue(throwingStorage());
    expect(wasPushPromptShown()).toBe(false);
    expect(() => writePushPromptRecord("shown", NOW)).not.toThrow();
    expect(wasPushPromptShown()).toBe(true);
    expect(readPushPromptRecord()).toEqual({ state: "shown", at: NOW });
  });
});

describe("the synchronous conditions", () => {
  const offered: PushPromptEnvironment = {
    eligible: true,
    alreadyShown: false,
    inTelegramMiniApp: false,
    support: "supported",
    appleMobile: false,
    standalone: false,
    permission: "default",
  };

  it("offers when every one holds — and on an iPhone or iPad only as a Home-Screen app", () => {
    expect(pushPromptRefusal(offered)).toBeNull();
    expect(pushPromptRefusal({ ...offered, appleMobile: true, standalone: true })).toBeNull();
  });

  it.each([
    ["no purchase in the last 30 minutes", { eligible: false }, "not-eligible"],
    ["shown before in this browser", { alreadyShown: true }, "already-shown"],
    ["inside the Telegram Mini App", { inTelegramMiniApp: true }, "telegram-mini-app"],
    ["a browser without push", { support: "unsupported-browser" }, "unsupported"],
    ["an iPhone in a Safari tab", { support: "unsupported-ios-not-installed" }, "unsupported"],
    ["an iPad (Mac user agent) in a browser tab", { appleMobile: true, standalone: false }, "apple-browser-tab"],
    ["permission already denied", { permission: "denied" }, "permission-not-default"],
    ["permission already granted", { permission: "granted" }, "permission-not-default"],
    ["no Notification API", { permission: null }, "permission-not-default"],
  ] as const)("refuses %s", (_case, over, reason) => {
    expect(pushPromptRefusal({ ...offered, ...over })).toBe(reason);
  });
});

describe("the onboarding tour", () => {
  it("is waited for while it runs and while it is about to start — as its provider says", () => {
    expect(mustWaitForTour({ tourActive: true, tourPending: false })).toBe(true);
    expect(mustWaitForTour({ tourActive: false, tourPending: true })).toBe(true);
    expect(mustWaitForTour({ tourActive: false, tourPending: false })).toBe(false);
  });
});
