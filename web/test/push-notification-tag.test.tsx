// @vitest-environment jsdom

/**
 * TWO NOTIFICATIONS MUST NOT ARRIVE AS ONE.
 *
 * A `tag` is a collapse key: a banner replaces any banner already on screen
 * with the same tag. The service worker derived it from the destination URL
 * alone — and the panel deep-links MANY notification types onto SIX pages.
 * `/renew` by itself serves `expires_in_3_days`, `expires_in_1_days`, `expired`
 * and `limited` (`resolveNotificationPushUrl`), so a customer whose plan lapsed
 * over a weekend was sent three warnings and shown one.
 *
 * It was harmless while the panel sent `TTL: 60`, because a closed browser
 * could never hold more than one message. `PUSH_TTL_SECONDS` is now a day, the
 * queue really fills, and the collapse became reachable the moment that landed
 * — i.e. it is a regression of the change that repaired push, not an old bug.
 *
 * The payload carries `title`, `body`, `url`, `icon` and `badgeCount` and
 * NOTHING that identifies the notification, so this half derives the key from
 * the words. The two cases at the bottom hold the other end: when a later panel
 * starts sending its own key, this file must already prefer it.
 *
 * Driven through the real handler rather than read out of the source. Two
 * sentinels in this subsystem have gone green over text while the behaviour
 * they named was broken.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("workbox-precaching", () => ({
  precache: () => undefined,
  addRoute: () => undefined,
  cleanupOutdatedCaches: () => undefined,
}));
vi.mock("workbox-routing", () => ({
  Route: class {
    constructor(
      readonly match: unknown,
      readonly handler: unknown,
    ) {}
  },
  registerRoute: () => undefined,
  setCatchHandler: () => undefined,
}));
vi.mock("workbox-strategies", () => {
  const strategy = () => class {};
  return { CacheFirst: strategy(), NetworkFirst: strategy(), StaleWhileRevalidate: strategy() };
});
vi.mock("workbox-expiration", () => ({ ExpirationPlugin: class {} }));
vi.mock("workbox-cacheable-response", () => ({ CacheableResponsePlugin: class {} }));

type Listener = (event: unknown) => void;

const listeners = new Map<string, Listener>();
const showNotification = vi.fn(async () => undefined);

interface PushPayload {
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly tag?: string;
  readonly type?: string;
}

/** Runs the worker's `push` handler over one payload and returns its options. */
async function deliver(payload: PushPayload): Promise<Record<string, unknown>> {
  const waited: unknown[] = [];
  const before = showNotification.mock.calls.length;
  listeners.get("push")?.({
    data: { json: () => payload },
    waitUntil: (value: unknown) => {
      waited.push(value);
    },
  });
  await Promise.all(waited);
  const call = showNotification.mock.calls[before] as unknown as [string, Record<string, unknown>];
  expect(call, "the worker drew no notification at all").toBeDefined();
  return call[1];
}

const tagOf = async (payload: PushPayload): Promise<string> =>
  (await deliver(payload)).tag as string;

beforeAll(async () => {
  // Captured instead of registered: nothing else in this file wants a live
  // listener on the jsdom window, and the handler is the unit under test.
  vi.spyOn(globalThis, "addEventListener").mockImplementation(((
    type: string,
    handler: Listener,
  ) => {
    listeners.set(type, handler);
  }) as never);
  Object.defineProperty(globalThis, "registration", {
    value: { showNotification },
    configurable: true,
    writable: true,
  });
  await import("../src/sw");
  expect(listeners.get("push"), "the worker registered no push handler").toBeTypeOf("function");
});

beforeEach(() => {
  showNotification.mockClear();
});

describe("the collapse key of a web-push banner", () => {
  it("differs for two notifications the panel points at the same page", async () => {
    // The exact production shape: the expiry family all resolves to `/renew`.
    const threeDays = await tagOf({
      title: "Подписка заканчивается",
      body: "Осталось 3 дня",
      url: "/renew",
    });
    const expired = await tagOf({
      title: "Подписка закончилась",
      body: "Продлите, чтобы продолжить",
      url: "/renew",
    });

    expect(
      expired,
      "both expiry notices carry one tag, so the second erased the first and the customer saw one banner out of the weekend's three",
    ).not.toBe(threeDays);
  });

  it("still collapses a re-send of the very same message", async () => {
    // Collapsing is not the enemy — collapsing DIFFERENT messages is. The same
    // words arriving twice should replace, not stack.
    const first = await tagOf({ title: "Ответ в поддержке", body: "Мы ответили", url: "/support" });
    const again = await tagOf({ title: "Ответ в поддержке", body: "Мы ответили", url: "/support" });

    expect(again).toBe(first);
  });

  it("is namespaced, so it cannot collide with another page's notifications", async () => {
    // Anti-vacuity: a tag of `""` would make every case above pass by making
    // every banner distinct-by-accident in some engines and identical in others.
    const tag = await tagOf({ title: "T", body: "B", url: "/dashboard" });

    expect(tag.startsWith("reiwa-notification:")).toBe(true);
    expect(tag.length).toBeGreaterThan("reiwa-notification:".length);
  });

  it("prefers a `tag` the panel sends, ignoring the words entirely", async () => {
    // FORWARD COMPATIBILITY, and the reason the fallback above is not the whole
    // answer: only the panel knows which row a push announces. Today it sends
    // nothing here; when it does, this side must already obey — and the shape
    // it must obey is `tag: string`, one per notification.
    const one = await tagOf({ title: "A", body: "B", url: "/renew", tag: "notif-7f3a" });
    const two = await tagOf({ title: "C", body: "D", url: "/dashboard", tag: "notif-7f3a" });

    expect(one).toBe("reiwa-notification:notif-7f3a");
    expect(two, "a tag the panel chose was not honoured").toBe(one);
  });

  it("falls back to a `type` when no tag was sent, and prefers the tag over it", async () => {
    expect(await tagOf({ title: "A", body: "B", url: "/renew", type: "expires_in_1_days" })).toBe(
      "reiwa-notification:expires_in_1_days",
    );
    expect(
      await tagOf({ title: "A", body: "B", url: "/renew", type: "expired", tag: "notif-1" }),
      "`type` won over `tag`, which is the coarser key winning over the finer one",
    ).toBe("reiwa-notification:notif-1");
  });

  it("ignores an empty tag rather than collapsing everything onto it", async () => {
    // A panel that sends the field but leaves it blank must behave exactly like
    // a panel that does not send it — otherwise one empty string becomes the
    // shared tag of every notification, which is the original defect restored.
    const blank = await tagOf({ title: "A", body: "B", url: "/renew", tag: "" });
    const other = await tagOf({ title: "C", body: "D", url: "/renew", tag: "" });

    expect(blank).not.toBe(other);
    expect(blank).not.toBe("reiwa-notification:");
  });
});
