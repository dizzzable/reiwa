// @vitest-environment jsdom

/**
 * What the onboarding tour tells the rest of the cabinet about itself.
 *
 * The tour kept its running state inside its provider, so anything that must
 * not appear under it had to guess — the push prompt read the spotlight layer's
 * class token off the DOM. The provider now publishes two facts through
 * `useOnboardingContext()`:
 *
 *   - `isActive` — the spotlight tour is on screen;
 *   - `autoStartPending` — it is about to start by itself: a customer who has
 *     not seen it, on the dashboard, with an active subscription and no card
 *     still being made, in the 600 ms before the start.
 *
 * And one guard: once the auto-start has fired, the tour is never "pending"
 * again in that provider's life — even when the server never confirmed it was
 * seen (a failed request), which would otherwise leave it due forever and keep
 * everything waiting on it hidden.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAllSubscriptions: vi.fn(),
  setOnboardingCompleted: vi.fn(),
}));
const session = vi.hoisted(() => ({ onboardingCompleted: false as boolean }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/dashboard", search: "", hash: "", state: null, key: "k" }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => ({
    session: { id: "u-1", telegramId: null, name: "U", role: "USER", onboardingCompleted: session.onboardingCompleted },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
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
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  };
});

import { OnboardingTourProvider, useOnboardingContext } from "@/features/onboarding/onboarding-tour-controller";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const seen: Array<{ isActive: boolean; autoStartPending: boolean }> = [];

function Probe() {
  const { isActive, autoStartPending } = useOnboardingContext();
  seen.push({ isActive, autoStartPending });
  return <div data-testid="tour-state">{`${String(isActive)}/${String(autoStartPending)}`}</div>;
}

function state(): string {
  return document.querySelector("[data-testid='tour-state']")?.textContent ?? "(none)";
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <OnboardingTourProvider>
          <div data-tour="subscription-card" />
          <Probe />
        </OnboardingTourProvider>
      </QueryClientProvider>,
    );
  });
  await advance(0);
}

function skipButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "onboarding.skip",
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  window.localStorage.clear();
  seen.length = 0;
  session.onboardingCompleted = false;
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [{ id: "sub-1", status: "ACTIVE" }] });
  api.setOnboardingCompleted.mockResolvedValue({ success: true });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useOnboardingContext — the tour's public state", () => {
  it("pending before the auto-start, active while it runs, neither once it is skipped", async () => {
    await mount();
    expect(state(), "not pending in the moment before the tour").toBe("false/true");

    await advance(700);
    expect(skipButton(), "the tour did not start").toBeDefined();
    expect(state()).toBe("true/false");

    await act(async () => skipButton()!.click());
    await advance(0);
    expect(skipButton()).toBeUndefined();
    expect(state()).toBe("false/false");
  });

  it("is never pending again once it has started — even when the server never confirmed it was seen", async () => {
    // The confirmation fails, so the session keeps saying "not seen": exactly
    // the state that would leave the tour due for ever.
    api.setOnboardingCompleted.mockRejectedValue(new Error("offline"));
    await mount();
    await advance(700);
    await act(async () => skipButton()!.click());
    await advance(5_000);

    expect(state()).toBe("false/false");
    expect(skipButton(), "the tour came back on its own").toBeUndefined();
  });

  it("is not pending for a customer who has seen it", async () => {
    session.onboardingCompleted = true;
    await mount();
    await advance(5_000);

    expect(seen.every((entry) => !entry.autoStartPending && !entry.isActive)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("is not pending without an active subscription, nor while a new card is still being made", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [{ id: "sub-1", status: "EXPIRED" }] });
    await mount();
    expect(state()).toBe("false/false");
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
    container?.remove();

    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [{ id: "sub-1", status: "ACTIVE" }] });
    window.sessionStorage.setItem(
      "reiwa:subscription-provisioning-receipts",
      JSON.stringify({
        version: 1,
        receipts: {
          "pay-1": {
            version: 1,
            paymentId: "pay-1",
            purchaseType: "NEW",
            slotIndex: 0,
            slotIndexSource: "CHECKOUT",
            createdAt: Date.now(),
            phase: "PROVISIONING",
          },
        },
      }),
    );
    await mount();
    expect(state()).toBe("false/false");
  });
});
