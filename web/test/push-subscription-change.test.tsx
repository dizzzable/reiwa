// @vitest-environment jsdom

/**
 * THE ROTATION HANDLER MUST NOT DESTROY A WORKING SUBSCRIPTION.
 *
 * `pushsubscriptionchange` exists to repair push, and the version that shipped
 * with the push fix began by unsubscribing unconditionally. That is safe only
 * under the reasoning written beside it — `subscribe()` with a DIFFERENT
 * `applicationServerKey` while one is live rejects `InvalidStateError` — and
 * that reasoning covers a key MISMATCH and nothing else. Two consequences, both
 * silent:
 *
 *   • the `subscribe()` that followed can throw for perfectly ordinary reasons
 *     (offline, the push service down, permission revoked in between). The
 *     `catch` at the bottom of the handler swallows it, and the browser is left
 *     with NO subscription where a moment earlier it had a good one. The panel
 *     meanwhile keeps a row it will only discover is dead on the next send.
 *
 *   • Chrome fires this event with `newSubscription` ALREADY ISSUED, so
 *     `getSubscription()` hands back the NEW one — and the handler unsubscribed
 *     a fresh, valid subscription in order to mint another.
 *
 * And the endpoint the browser retired was dropped on the floor, so the panel's
 * row for it survived until a send 410'd it: until then one notification went
 * to two endpoints, one of them nobody's.
 *
 * The last case is the sibling defect in `push-key-match.ts`: an engine that
 * does not report `applicationServerKey` at all (historically Firefox, some
 * Safari) must not be read as "the key is wrong".
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

/** The VAPID key the BFF hands out, URL-safe base64 of four bytes. */
const CURRENT_KEY = "AQIDBA";
/** A different one — what a rotation looks like from here. */
const ROTATED_KEY = "BQYHCA";

interface FakeSubscription {
  readonly endpoint: string;
  readonly options: { applicationServerKey: ArrayBuffer | null };
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  readonly toJSON: () => { keys: { p256dh: string; auth: string } };
}

function keyBytes(base64: string): ArrayBuffer {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

function subscription(endpoint: string, key: ArrayBuffer | null): FakeSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ keys: { p256dh: "p256", auth: "auth" } }),
  };
}

const pushManager = {
  getSubscription: vi.fn(async (): Promise<FakeSubscription | null> => null),
  subscribe: vi.fn(async (): Promise<FakeSubscription> => subscription("https://push/new", null)),
};

const postMessage = vi.fn();
const matchAll = vi.fn(async () => [{ postMessage }]);

/** Every request the handler made, in order. */
let requests: Array<{ url: string; body: unknown }> = [];
/** Status for `POST /api/v1/push/subscribe`. */
let saveStatus = 200;

const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  requests.push({
    url,
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
  });
  if (url.endsWith("/push/public-key")) {
    return { ok: true, status: 200, json: async () => ({ publicKey: CURRENT_KEY }) };
  }
  if (url.endsWith("/push/subscribe")) {
    return { ok: saveStatus >= 200 && saveStatus < 300, status: saveStatus, json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
});

/** Fires the worker's `pushsubscriptionchange` handler and drains its work. */
async function rotate(oldSubscription?: FakeSubscription): Promise<void> {
  const waited: unknown[] = [];
  listeners.get("pushsubscriptionchange")?.({
    oldSubscription: oldSubscription ?? null,
    waitUntil: (value: unknown) => {
      waited.push(value);
    },
  });
  await Promise.all(waited);
}

const urlsOf = (): string[] => requests.map((r) => new URL(r.url, "https://cabinet").pathname);

beforeAll(async () => {
  vi.spyOn(globalThis, "addEventListener").mockImplementation(((
    type: string,
    handler: Listener,
  ) => {
    listeners.set(type, handler);
  }) as never);
  Object.defineProperty(globalThis, "registration", {
    value: { showNotification: vi.fn(async () => undefined), pushManager },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "clients", {
    value: { matchAll },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("fetch", fetchMock);
  await import("../src/sw");
  expect(
    listeners.get("pushsubscriptionchange"),
    "the worker registered no rotation handler",
  ).toBeTypeOf("function");
});

beforeEach(() => {
  requests = [];
  saveStatus = 200;
  pushManager.getSubscription.mockReset();
  pushManager.subscribe.mockReset();
  postMessage.mockClear();
  pushManager.getSubscription.mockResolvedValue(null);
  pushManager.subscribe.mockImplementation(async () =>
    subscription("https://push/new", keyBytes(CURRENT_KEY)),
  );
});

describe("a push subscription the browser says has changed", () => {
  it("keeps the one already minted with the current key, and re-registers it", async () => {
    // Chrome's own shape: `newSubscription` is already issued, so this is what
    // `getSubscription()` returns. Tearing it down to mint another is pure loss.
    const live = subscription("https://push/live", keyBytes(CURRENT_KEY));
    pushManager.getSubscription.mockResolvedValue(live);

    await rotate();

    expect(
      live.unsubscribe,
      "a valid subscription was unsubscribed in order to issue another",
    ).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    const save = requests.find((r) => r.url.endsWith("/push/subscribe"));
    expect(save?.body).toMatchObject({ endpoint: "https://push/live" });
  });

  it("replaces one minted with a key the operator has rotated away from", async () => {
    // The other half: this IS the case the unconditional unsubscribe was
    // written for, and it must still work.
    const stale = subscription("https://push/stale", keyBytes(ROTATED_KEY));
    pushManager.getSubscription.mockResolvedValue(stale);

    await rotate();

    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves the browser subscribed when minting a replacement fails", async () => {
    // Offline, push service down, permission revoked between the two calls. The
    // handler's own `catch` swallows all of it — so whatever it destroyed on
    // the way in is destroyed for good, and this event runs at most once.
    const live = subscription("https://push/live", keyBytes(CURRENT_KEY));
    pushManager.getSubscription.mockResolvedValue(live);
    pushManager.subscribe.mockRejectedValue(new Error("push service unreachable"));

    await rotate();

    expect(
      live.unsubscribe,
      "the only working subscription was thrown away before finding out whether a replacement could be issued",
    ).not.toHaveBeenCalled();
  });

  it("retires the endpoint the browser replaced, after the new one is saved", async () => {
    // Otherwise the panel keeps a row for a dead endpoint until a send 410s it,
    // and until then one notification is delivered to two endpoints.
    const retired = subscription("https://push/old", keyBytes(CURRENT_KEY));
    pushManager.getSubscription.mockResolvedValue(null);

    await rotate(retired);

    expect(urlsOf()).toEqual([
      "/api/v1/push/public-key",
      "/api/v1/push/subscribe",
      "/api/v1/push/unsubscribe",
    ]);
    expect(requests.at(-1)?.body).toEqual({ endpoint: "https://push/old" });
  });

  it("does not retire the endpoint it has just registered", async () => {
    // The ordinary reuse case: the old and the new are the SAME endpoint, and
    // an unguarded retirement would delete the row written one line earlier.
    const live = subscription("https://push/live", keyBytes(CURRENT_KEY));
    pushManager.getSubscription.mockResolvedValue(live);

    await rotate(live);

    expect(urlsOf()).not.toContain("/api/v1/push/unsubscribe");
  });

  it("tells the open pages when the re-registration is refused", async () => {
    // `console.warn` from a worker lands in a DevTools pane nobody opens, so
    // the one side that knew push had stopped told nobody. The page needs this
    // to retire its "already healed" marker.
    saveStatus = 401;
    const retired = subscription("https://push/old", keyBytes(CURRENT_KEY));

    await rotate(retired);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "PUSH_RESYNC_FAILED",
      status: 401,
    });
    // And nothing is retired on a failure — the old row is all the customer has
    // left.
    expect(urlsOf()).not.toContain("/api/v1/push/unsubscribe");
  });

  it("keeps a subscription whose key the engine refuses to report", async () => {
    // Firefox and some Safari builds expose no `applicationServerKey`. Reading
    // that as a mismatch minted a NEW endpoint on every single heal, never
    // retired the previous one, and fanned one notification out across all of
    // them until each 410'd.
    const opaque = subscription("https://push/opaque", null);
    pushManager.getSubscription.mockResolvedValue(opaque);

    await rotate();

    expect(
      opaque.unsubscribe,
      "a healthy subscription was destroyed because the browser declined to say which key made it",
    ).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });
});
