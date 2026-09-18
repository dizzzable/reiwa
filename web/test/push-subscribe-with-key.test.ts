// @vitest-environment jsdom

/**
 * `subscribeToPushWithKey` — the subscribe a button can call in the same tap.
 *
 * A permission request made after an await is made outside the tap's user
 * activation, and browsers then refuse it or never show it (the same loss that
 * once broke the payment redirect). So the order is the contract: the
 * permission request is issued SYNCHRONOUSLY by the call — before it returns
 * its promise — and nothing on the network comes before it. The key was
 * fetched before the button was shown and is handed in.
 *
 * `isAppleMobileDevice` — iPadOS sends a Mac user agent; the touch points give
 * it away. `subscribeToPush` is the settings page's path and keeps its order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(),
  pushSubscribe: vi.fn(),
  pushUnsubscribe: vi.fn(),
}));
vi.mock("@/lib/api-client", () => api);

import { isAppleMobileDevice, subscribeToPush, subscribeToPushWithKey } from "@/lib/push";

/** A real-looking P-256 public key, URL-safe base64 without padding. */
const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

let order: string[];
let permissionAnswer: NotificationPermission;
const requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
  order.push("permission");
  return permissionAnswer;
});
const pushManager = {
  subscribe: vi.fn(async (options: { applicationServerKey: ArrayBuffer }) => {
    order.push("subscribe");
    void options;
    return subscription;
  }),
  getSubscription: vi.fn(async () => null),
};
const subscription = {
  endpoint: "https://push.example/endpoint-1",
  toJSON: () => ({ keys: { p256dh: "p256dh-1", auth: "auth-1" } }),
  unsubscribe: vi.fn(async () => {
    order.push("unsubscribe");
    return true;
  }),
};

function stubBrowser(): void {
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
}

function stubDevice(userAgent: string, maxTouchPoints: number): void {
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => userAgent });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => maxTouchPoints });
}

beforeEach(() => {
  order = [];
  permissionAnswer = "granted";
  for (const fn of [...Object.values(api), requestPermission, pushManager.subscribe, subscription.unsubscribe]) {
    fn.mockClear();
  }
  api.getPushPublicKey.mockImplementation(async () => {
    order.push("key");
    return { publicKey: KEY };
  });
  api.pushSubscribe.mockImplementation(async () => {
    order.push("bff");
    return { success: true };
  });
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(navigator, "userAgent");
  Reflect.deleteProperty(navigator, "maxTouchPoints");
});

describe("subscribeToPushWithKey — the permission request comes first, inside the tap", () => {
  it("asks for permission before it returns, with nothing on the network before it", async () => {
    const pending = subscribeToPushWithKey(KEY);
    // Synchronously, before the caller could have awaited anything.
    expect(requestPermission, "the permission request waited on something first").toHaveBeenCalledTimes(1);
    expect(order).toEqual(["permission"]);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(order).toEqual(["permission", "subscribe", "bff"]);
    expect(api.getPushPublicKey, "the key was fetched again inside the tap").not.toHaveBeenCalled();
    expect(new Uint8Array(pushManager.subscribe.mock.calls[0]![0].applicationServerKey)).toHaveLength(65);
    expect(api.pushSubscribe).toHaveBeenCalledWith({
      endpoint: "https://push.example/endpoint-1",
      keys: { p256dh: "p256dh-1", auth: "auth-1" },
      userAgent: navigator.userAgent,
    });
  });

  it("stops at a refusal, and subscribes nothing", async () => {
    permissionAnswer = "denied";
    await expect(subscribeToPushWithKey(KEY)).resolves.toEqual({ ok: false, reason: "permission-denied" });
    expect(order).toEqual(["permission"]);
  });

  it("asks nothing at all without a key", async () => {
    await expect(subscribeToPushWithKey("")).resolves.toEqual({ ok: false, reason: "no-public-key" });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("takes the browser's subscription back when the cabinet cannot store it", async () => {
    api.pushSubscribe.mockRejectedValue(new Error("502"));
    await expect(subscribeToPushWithKey(KEY)).resolves.toEqual({ ok: false, reason: "subscribe-failed" });
    expect(order).toEqual(["permission", "subscribe", "unsubscribe"]);
  });
});

describe("subscribeToPush — the settings page's path keeps its order", () => {
  it("asks first, then fetches the key, then subscribes", async () => {
    await expect(subscribeToPush()).resolves.toEqual({ ok: true });
    expect(order).toEqual(["permission", "key", "subscribe", "bff"]);
  });
});

describe("isAppleMobileDevice — iPadOS behind a Mac user agent", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const IPAD_AS_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
  const CHROME_ON_IPAD = "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36";

  it.each([
    ["an iPhone", IPHONE, 5, true],
    ["an iPad that says it is a Mac, and has touch points", IPAD_AS_MAC, 5, true],
    ["any browser on an iPad", CHROME_ON_IPAD, 5, true],
    ["a real Mac", IPAD_AS_MAC, 0, false],
    ["an Android phone", ANDROID, 5, false],
  ] as const)("%s", (_case, userAgent, touchPoints, expected) => {
    stubDevice(userAgent, touchPoints);
    expect(isAppleMobileDevice()).toBe(expected);
  });
});
