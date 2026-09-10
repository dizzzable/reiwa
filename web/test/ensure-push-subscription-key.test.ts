// @vitest-environment jsdom

/**
 * The load-time heal must not mint a new endpoint on every single load.
 *
 * `ensurePushSubscription()` runs on every cabinet entry and drops the local
 * subscription when it was minted with a VAPID key the operator has rotated
 * away from. The comparison read "the browser did not report a key" as "the key
 * is wrong" — and `PushSubscriptionOptions.applicationServerKey` is not exposed
 * by every engine (historically Firefox, some Safari builds).
 *
 * On those engines every load therefore: unsubscribed a working subscription,
 * minted a fresh endpoint, told the panel about it — and never told the panel
 * about the one it had just abandoned. The rows accumulated one per load, each
 * of them live until a send finally 410'd it, so a single notification fanned
 * out across all of them. The replacement reported no key either, so the next
 * load did it again.
 *
 * The rotation case must still work, which is what the second case holds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(),
  pushSubscribe: vi.fn(),
  pushUnsubscribe: vi.fn(),
}));

vi.mock("@/lib/api-client", () => api);

import { ensurePushSubscription } from "@/lib/push";

/** URL-safe base64 of four bytes, and a different four. */
const CURRENT_KEY = "AQIDBA";
const ROTATED_KEY = "BQYHCA";

function keyBytes(base64: string): ArrayBuffer {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

function subscription(endpoint: string, key: ArrayBuffer | null) {
  return {
    endpoint,
    options: { applicationServerKey: key },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ keys: { p256dh: "p256", auth: "auth" } }),
  };
}

const pushManager = {
  getSubscription: vi.fn(),
  subscribe: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getPushPublicKey.mockResolvedValue({ publicKey: CURRENT_KEY });
  api.pushSubscribe.mockResolvedValue({ success: true });
  pushManager.subscribe.mockImplementation(async () =>
    subscription("https://push/fresh", keyBytes(CURRENT_KEY)),
  );
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve({ pushManager }) },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "serviceWorker");
});

describe("the load-time push heal", () => {
  it("keeps a subscription whose key the engine will not report", async () => {
    const opaque = subscription("https://push/opaque", null);
    pushManager.getSubscription.mockResolvedValue(opaque);

    await expect(ensurePushSubscription()).resolves.toBe(true);

    expect(
      opaque.unsubscribe,
      "a healthy endpoint was replaced because the browser declined to say which key made it — one new row per cabinet load, none of them retired",
    ).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.pushSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push/opaque" }),
    );
  });

  it("still replaces one minted with a key that has been rotated away from", async () => {
    const stale = subscription("https://push/stale", keyBytes(ROTATED_KEY));
    pushManager.getSubscription.mockResolvedValue(stale);

    await expect(ensurePushSubscription()).resolves.toBe(true);

    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(api.pushSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push/fresh" }),
    );
  });

  it("re-registers a matching subscription without touching it", async () => {
    const live = subscription("https://push/live", keyBytes(CURRENT_KEY));
    pushManager.getSubscription.mockResolvedValue(live);

    await expect(ensurePushSubscription()).resolves.toBe(true);

    expect(live.unsubscribe).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });
});
