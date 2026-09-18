// @vitest-environment jsdom

/**
 * The push prompt on the dashboard — the real card, the real `lib/push`, the
 * real Mini App and Home-Screen detection, the real dictionaries. Only the
 * browser is stubbed (Notification, the service worker and its PushManager, the
 * user agent, the display mode) and the three push calls to the cabinet.
 *
 * The owner's rules, each asserted as behaviour:
 *   - only right after a purchase or a trial (30 minutes), only once per browser;
 *   - never in the Telegram Mini App; on iPhone/iPad only as a Home-Screen app —
 *     iPadOS included, which hides behind a Mac user agent;
 *   - only while the permission is still `default`, only with the operator's key
 *     fetched BEFORE the card shows, only without a subscription on this device;
 *   - it waits while the onboarding tour runs;
 *   - [Включить] asks for permission inside the tap — nothing awaited first,
 *     nothing on the network first; every outcome is remembered;
 *   - [Не сейчас] means never again in this browser.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(),
  pushSubscribe: vi.fn(),
  pushUnsubscribe: vi.fn(),
}));
vi.mock("@/lib/api-client", () => api);

const sessionState = vi.hoisted(() => ({ onboardingCompleted: true as boolean | undefined }));
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({
    session: { id: "u-1", telegramId: null, name: "U", role: "USER", onboardingCompleted: sessionState.onboardingCompleted },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

import { i18n } from "@/i18n/i18n";
import { PUSH_PROMPT_SW_READY_TIMEOUT_MS, PushPromptCard } from "@/features/push-prompt/push-prompt-card";
import {
  isPushPromptEligible,
  markPushPromptEligible,
  PUSH_PROMPT_ELIGIBLE_TTL_MS,
  readPushPromptRecord,
  resetPushPromptMemoryForTests,
  wasPushPromptShown,
} from "@/features/push-prompt/push-prompt-storage";
import { SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT } from "@/lib/subscription-provisioning-receipt";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

interface Browser {
  userAgent: string;
  touchPoints: number;
  /** Opened as an installed app (display-mode standalone / iOS `navigator.standalone`). */
  standalone: boolean;
  permission: NotificationPermission;
  /** What the browser's own question ends with. */
  answer: NotificationPermission;
  /** The push subscription this browser already holds. */
  current: unknown;
  /** `false`: a service worker that never becomes ready. */
  swReady: boolean;
}

let browser: Browser;
let log: string[];
const notification = {
  permission: "default" as NotificationPermission,
  requestPermission: vi.fn(async (): Promise<NotificationPermission> => {
    log.push("permission");
    notification.permission = browser.answer;
    return browser.answer;
  }),
};
const pushSubscription = {
  endpoint: "https://push.example/endpoint-1",
  toJSON: () => ({ keys: { p256dh: "p256dh-1", auth: "auth-1" } }),
  unsubscribe: vi.fn(async () => true),
};
const pushManager = {
  getSubscription: vi.fn(async () => {
    log.push("getSubscription");
    return browser.current;
  }),
  subscribe: vi.fn(async () => {
    log.push("subscribe");
    return pushSubscription;
  }),
};

function stubBrowser(): void {
  notification.permission = browser.permission;
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: browser.swReady ? Promise.resolve({ pushManager }) : new Promise(() => {}) },
  });
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => browser.userAgent });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => browser.touchPoints });
  Object.defineProperty(navigator, "standalone", { configurable: true, get: () => browser.standalone });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: media.includes("standalone") ? browser.standalone : false,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
}

const tr = (key: string, options?: Record<string, unknown>): string => {
  const text = i18n.t(key, options);
  expect(text, `no translation for ${key}`).not.toBe(key);
  return text;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mountCard(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PushPromptCard />);
  });
  await advance(0);
  await advance(0);
}

async function unmountCard(): Promise<void> {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  root = null;
  container = null;
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='push-prompt']");
}

function enableButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-testid='push-prompt-enable']");
}

function laterButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-testid='push-prompt-later']");
}

function result(): string | null {
  return document.querySelector("[data-testid='push-prompt-result']")?.textContent ?? null;
}

async function tap(button: HTMLButtonElement | null, what: string): Promise<void> {
  if (!button) throw new Error(`no ${what}; on screen: ${document.body.textContent}`);
  await act(async () => {
    button.click();
  });
  await advance(0);
  await advance(0);
}

beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetPushPromptMemoryForTests();
  sessionState.onboardingCompleted = true;
  log = [];
  browser = {
    userAgent: DESKTOP_CHROME,
    touchPoints: 0,
    standalone: false,
    permission: "default",
    answer: "granted",
    current: null,
    swReady: true,
  };
  for (const fn of [...Object.values(api), notification.requestPermission, pushManager.getSubscription, pushManager.subscribe]) {
    fn.mockClear();
  }
  api.getPushPublicKey.mockImplementation(async () => {
    log.push("key");
    return { publicKey: KEY };
  });
  api.pushSubscribe.mockImplementation(async () => {
    log.push("bff");
    return { success: true };
  });
  stubBrowser();
});

afterEach(async () => {
  await unmountCard();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const property of ["serviceWorker", "userAgent", "maxTouchPoints", "standalone"]) {
    Reflect.deleteProperty(navigator, property);
  }
  Reflect.deleteProperty(window, "Telegram");
});

describe("offered right after a purchase", () => {
  it("shows the owner's words and two buttons — once the key is in and no subscription exists", async () => {
    markPushPromptEligible();
    await mountCard();

    expect(card(), "no card after a purchase in a browser that can take push").not.toBeNull();
    expect(card()!.textContent).toContain(tr("pushPrompt.text"));
    expect(enableButton()?.textContent).toBe(tr("pushPrompt.enable"));
    expect(laterButton()?.textContent).toBe(tr("pushPrompt.later"));
    // The key and the device's own subscription were read BEFORE it appeared.
    expect(log).toEqual(["key", "getSubscription"]);
    expect(readPushPromptRecord()?.state).toBe("shown");
    // The moment is used up: another dashboard visit this session offers nothing new.
    expect(isPushPromptEligible()).toBe(false);
  });

  it("is made eligible by the dashboard's «subscription ready» — a purchase or a free trial", async () => {
    await mountCard();
    expect(card()).toBeNull();
    expect(api.getPushPublicKey, "the key was fetched with nothing bought").not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT));
    });
    await advance(0);
    await advance(0);

    expect(card(), "a new subscription became ready and nothing was offered").not.toBeNull();
  });

  it("does not show until the key has arrived", async () => {
    const keyRequest: { answer: ((value: { publicKey: string }) => void) | null } = { answer: null };
    api.getPushPublicKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          keyRequest.answer = resolve;
        }),
    );
    markPushPromptEligible();
    await mountCard();
    expect(card(), "shown before the key was known").toBeNull();
    expect(keyRequest.answer, "the key was never asked for").not.toBeNull();

    await act(async () => {
      keyRequest.answer?.({ publicKey: KEY });
    });
    await advance(0);
    await advance(0);
    expect(card()).not.toBeNull();
  });
});

describe("[Включить]", () => {
  it("asks for permission inside the tap: nothing awaited first, nothing on the network first", async () => {
    markPushPromptEligible();
    await mountCard();
    const button = enableButton();
    expect(button).not.toBeNull();
    const keyFetches = api.getPushPublicKey.mock.calls.length;
    log = [];

    let permissionRequestsWhenTapReturned = -1;
    await act(async () => {
      button!.click();
      permissionRequestsWhenTapReturned = notification.requestPermission.mock.calls.length;
    });
    await advance(0);
    await advance(0);

    expect(
      permissionRequestsWhenTapReturned,
      "the permission request waited on something — outside the tap's user activation",
    ).toBe(1);
    expect(api.getPushPublicKey.mock.calls.length, "the key was fetched again inside the tap").toBe(keyFetches);
    expect(log).toEqual(["permission", "subscribe", "bff"]);
    expect(api.pushSubscribe).toHaveBeenCalledWith({
      endpoint: "https://push.example/endpoint-1",
      keys: { p256dh: "p256dh-1", auth: "auth-1" },
      userAgent: DESKTOP_CHROME,
    });
    expect(result()).toBe(tr("pushPrompt.enabled"));
    expect(readPushPromptRecord()?.state).toBe("accepted");
  });

  it("a refusal in the browser's own question: says how to undo it, and remembers", async () => {
    browser.answer = "denied";
    markPushPromptEligible();
    await mountCard();
    await tap(enableButton(), "[Включить]");

    expect(result()).toBe(tr("pushPrompt.blocked"));
    expect(readPushPromptRecord()?.state).toBe("denied");
    expect(api.pushSubscribe).not.toHaveBeenCalled();
  });

  it("the browser's question closed without an answer: points at the settings switch, and remembers", async () => {
    browser.answer = "default";
    markPushPromptEligible();
    await mountCard();
    await tap(enableButton(), "[Включить]");

    expect(result()).toBe(tr("pushPrompt.notEnabled"));
    // Once means once: a closed question is not asked again either.
    expect(readPushPromptRecord()?.state).toBe("denied");
  });

  it("a subscription that fails: says so, and remembers", async () => {
    pushManager.subscribe.mockRejectedValueOnce(new Error("AbortError"));
    markPushPromptEligible();
    await mountCard();
    await tap(enableButton(), "[Включить]");

    expect(result()).toBe(tr("pushPrompt.failed"));
    expect(readPushPromptRecord()?.state).toBe("failed");
  });
});

describe("[Не сейчас], and once per browser", () => {
  it("goes away, and is never shown again in this browser", async () => {
    markPushPromptEligible();
    await mountCard();
    await tap(laterButton(), "[Не сейчас]");

    expect(card()).toBeNull();
    expect(readPushPromptRecord()?.state).toBe("dismissed");
    expect(notification.requestPermission).not.toHaveBeenCalled();

    // The next purchase, another visit: nothing — and nothing fetched for it.
    await unmountCard();
    api.getPushPublicKey.mockClear();
    markPushPromptEligible();
    await mountCard();
    expect(card()).toBeNull();
    expect(api.getPushPublicKey).not.toHaveBeenCalled();
  });

  it("counts as shown the moment it appears, whatever happens next", async () => {
    markPushPromptEligible();
    await mountCard();
    expect(card()).not.toBeNull();
    await unmountCard();

    markPushPromptEligible();
    await mountCard();
    expect(card()).toBeNull();
  });

  it("works when this browser refuses local storage — no crash, and still once for the page", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    markPushPromptEligible();
    await mountCard();
    expect(card()).not.toBeNull();
    await tap(laterButton(), "[Не сейчас]");
    expect(card()).toBeNull();
    expect(wasPushPromptShown()).toBe(true);

    await unmountCard();
    markPushPromptEligible();
    await mountCard();
    expect(card()).toBeNull();
  });
});

describe("not offered where it cannot work", () => {
  async function expectNothing(): Promise<void> {
    markPushPromptEligible();
    await mountCard();
    await advance(PUSH_PROMPT_SW_READY_TIMEOUT_MS + 1_000);
    expect(card()).toBeNull();
    expect(wasPushPromptShown(), "counted as shown without being shown").toBe(false);
  }

  it("inside the Telegram Mini App", async () => {
    (window as { Telegram?: unknown }).Telegram = { WebApp: {} };
    await expectNothing();
    expect(api.getPushPublicKey).not.toHaveBeenCalled();
  });

  it("on an iPhone in a Safari tab", async () => {
    browser.userAgent = IPHONE_SAFARI;
    browser.touchPoints = 5;
    stubBrowser();
    await expectNothing();
  });

  it("on an iPad in a browser tab, although it says it is a Mac", async () => {
    browser.userAgent = IPAD_AS_MAC;
    browser.touchPoints = 5;
    stubBrowser();
    await expectNothing();
    expect(api.getPushPublicKey).not.toHaveBeenCalled();
  });

  it("but it is offered on an iPad added to the Home Screen", async () => {
    browser.userAgent = IPAD_AS_MAC;
    browser.touchPoints = 5;
    browser.standalone = true;
    stubBrowser();
    markPushPromptEligible();
    await mountCard();
    expect(card()).not.toBeNull();
  });

  it.each(["denied", "granted"] as const)("once the permission is already %s", async (permission) => {
    browser.permission = permission;
    stubBrowser();
    await expectNothing();
    // A browser that has already decided costs no request either.
    expect(api.getPushPublicKey).not.toHaveBeenCalled();
    expect(pushManager.getSubscription).not.toHaveBeenCalled();
  });

  it("when the operator has no push key: no card, and no permission asked", async () => {
    api.getPushPublicKey.mockResolvedValue({ publicKey: "" });
    await expectNothing();
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it("when this device is already subscribed", async () => {
    browser.current = { endpoint: "https://push.example/already" };
    await expectNothing();
  });

  it("when the service worker never answers — a tap would wait on it too", async () => {
    browser.swReady = false;
    stubBrowser();
    await expectNothing();
  });

  it("more than 30 minutes after the purchase", async () => {
    markPushPromptEligible(Date.now() - PUSH_PROMPT_ELIGIBLE_TTL_MS - 1);
    await mountCard();
    expect(card()).toBeNull();
    expect(api.getPushPublicKey).not.toHaveBeenCalled();
  });
});

describe("the onboarding tour", () => {
  it("waits while the tour is on screen, and shows once it has closed", async () => {
    const tour = document.createElement("div");
    tour.className = "fixed inset-0 z-[9998]";
    document.body.append(tour);
    markPushPromptEligible();
    await mountCard();
    await advance(10_000);

    expect(card(), "shown over the running tour").toBeNull();
    expect(wasPushPromptShown(), "counted as shown while the tour covered it").toBe(false);

    tour.remove();
    await advance(500);
    expect(card(), "never shown after the tour closed").not.toBeNull();
    expect(readPushPromptRecord()?.state).toBe("shown");
  });

  it("waits for a tour that is due but has not started yet — and not forever", async () => {
    sessionState.onboardingCompleted = false;
    markPushPromptEligible();
    await mountCard();
    await advance(2_000);
    expect(card(), "shown before a due tour had its chance to start").toBeNull();

    await advance(1_500);
    expect(card(), "waited forever for a tour that never came").not.toBeNull();
  });
});
