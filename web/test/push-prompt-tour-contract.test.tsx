// @vitest-environment jsdom

/**
 * The push prompt and the REAL onboarding tour, together.
 *
 * The tour keeps its running state inside its own provider and exposes none of
 * it, so the prompt reads the tour's presence from its spotlight layer
 * (`isOnboardingTourOnScreen`). That is a contract with a file the prompt does
 * not own — a renamed class, a different layer — and it would break silently:
 * the card would just appear under the tour. This renders the real provider,
 * lets it start the tour the way it does for a first purchase (600 ms after the
 * dashboard has an active subscription), and holds the prompt to it: nothing
 * while the tour runs, the card once it is skipped.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAllSubscriptions: vi.fn(),
  setOnboardingCompleted: vi.fn(),
  getPushPublicKey: vi.fn(),
  pushSubscribe: vi.fn(),
  pushUnsubscribe: vi.fn(),
}));
vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/dashboard", search: "", hash: "", state: null, key: "k" }),
}));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  // A customer who has never seen the tour: it is due on this dashboard.
  useSession: () => ({
    session: { id: "u-1", telegramId: null, name: "U", role: "USER", onboardingCompleted: false },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
// Exit animations finish at once, so "skipped" means "gone".
vi.mock("motion/react", async () => {
  const { createElement } = await import("react");
  const strip = (props: Record<string, unknown>): Record<string, unknown> => {
    const { initial, animate, exit, transition, whileTap, whileHover, layout, ...rest } = props;
    return rest;
  };
  return {
    motion: new Proxy(
      {},
      { get: (_target, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) },
    ),
    AnimatePresence: ({ children }: { children?: unknown }) => children,
  };
});

import { i18n } from "@/i18n/i18n";
import { OnboardingTourProvider } from "@/features/onboarding/onboarding-tour-controller";
import { PushPromptCard } from "@/features/push-prompt/push-prompt-card";
import { isOnboardingTourOnScreen } from "@/features/push-prompt/push-prompt-policy";
import {
  markPushPromptEligible,
  resetPushPromptMemoryForTests,
  wasPushPromptShown,
} from "@/features/push-prompt/push-prompt-storage";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function stubPushCapableBrowser(): void {
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "granted") });
  vi.stubGlobal("PushManager", function PushManager() {});
  const pushManager = { getSubscription: vi.fn(async () => null), subscribe: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='push-prompt']");
}

beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetPushPromptMemoryForTests();
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [{ id: "sub-1", status: "ACTIVE" }] });
  api.setOnboardingCompleted.mockResolvedValue({ success: true });
  api.getPushPublicKey.mockResolvedValue({ publicKey: KEY });
  stubPushCapableBrowser();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("the push prompt waits for the real onboarding tour", () => {
  it("sees the tour the provider starts, stays hidden while it runs, and shows once it is skipped", async () => {
    markPushPromptEligible();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <OnboardingTourProvider>
            <div data-tour="subscription-card" />
            <PushPromptCard />
          </OnboardingTourProvider>
        </QueryClientProvider>,
      );
    });

    // The provider starts the tour 600 ms after it has an active subscription.
    await advance(1_000);
    expect(isOnboardingTourOnScreen(), "the prompt cannot see the tour the provider started").toBe(true);
    expect(card(), "the prompt appeared under the tour").toBeNull();

    // A long read of the tour: still nothing, and nothing counted as shown.
    await advance(30_000);
    expect(card()).toBeNull();
    expect(wasPushPromptShown()).toBe(false);

    const skip = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === i18n.t("onboarding.skip"),
    );
    expect(skip, "no «Пропустить» on the tour").toBeDefined();
    await act(async () => {
      skip!.click();
    });
    await advance(1_000);

    expect(isOnboardingTourOnScreen()).toBe(false);
    expect(card(), "the prompt never appeared after the tour closed").not.toBeNull();
    expect(wasPushPromptShown()).toBe(true);
  });
});
