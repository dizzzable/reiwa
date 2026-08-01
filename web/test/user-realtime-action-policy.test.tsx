// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/use-session", () => ({
  useSession: () => ({ isAuthenticated: true }),
}));

vi.mock("@/lib/api-client", () => ({
  signOut: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

import { useUserRealtime } from "../src/hooks/use-user-realtime";
import { subscriptionQueryKeys } from "../src/lib/subscription-query-keys";

class FakeEventSource {
  static latest: FakeEventSource | null = null;

  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.latest = this;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {}

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

function RealtimeProbe() {
  useUserRealtime({ showToasts: false });
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.latest = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("realtime action-policy invalidation", () => {
  it("invalidates a cached trial policy when upgrade completes", () => {
    const queryClient = new QueryClient();
    const trialPolicyKey = subscriptionQueryKeys.actionPolicy("trial-subscription");
    queryClient.setQueryData(trialPolicyKey, { canRenew: false });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <RealtimeProbe />
        </QueryClientProvider>,
      );
    });

    expect(FakeEventSource.latest?.url).toBe("/api/v1/realtime/stream");
    expect(queryClient.getQueryState(trialPolicyKey)?.isInvalidated).toBe(false);

    act(() => {
      FakeEventSource.latest?.emit("subscription.upgraded", {
        type: "subscription.upgraded",
        category: "SUBSCRIPTION",
        severity: "INFO",
        message: "Upgraded",
        metadata: {},
        timestamp: "2026-07-31T00:00:00.000Z",
      });
      vi.advanceTimersByTime(401);
    });

    expect(queryClient.getQueryState(trialPolicyKey)?.isInvalidated).toBe(true);
  });
});
