// @vitest-environment jsdom

/**
 * WHAT THE CUSTOMER'S TOAST ACTUALLY SAYS.
 *
 * `realtime-event-copy.test.ts` pins `realtimeEventText` as a pure function and
 * pins its list against the query-key registry. Both are right, and neither
 * reaches the ONE line that calls it: replacing
 * `const text = realtimeEventText(tRef.current, event)` with
 * `const text = event.message` left the whole cabinet suite green.
 *
 * That is the leak the copy layer was written for. The panel's sentence is
 * neutral English now — so on a current pairing the cost is a Russian customer
 * reading English — but the panel and this cabinet ship as separate images and
 * upgrade independently, and against an older panel the same line puts
 * `Remnawave profile created: <the operator's naming scheme around the
 * customer's login>` on a customer's screen.
 *
 * The reason nothing covered it: the only test that mounts this hook passes
 * `showToasts: false`, so the entire toast branch executed in no test in the
 * repository.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/use-session", () => ({
  useSession: () => ({ isAuthenticated: true }),
}));

vi.mock("@/lib/api-client", () => ({ signOut: vi.fn() }));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// THE REAL BUNDLES, loaded before the hook. Without them every `t()` returns
// its own key, `realtimeEventText` falls back to the panel sentence exactly as
// designed, and this file would report a leak that is not there — which is what
// it did on the first run.
import "@/i18n/i18n";

import { useUserRealtime } from "../src/hooks/use-user-realtime";

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

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
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

function ToastingProbe() {
  // TRUE, which is the point: the branch under test is behind this flag and
  // every other test of this hook turns it off.
  useUserRealtime({ showToasts: true });
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.latest = null;
  toastMock.error.mockClear();
  toastMock.warning.mockClear();
  toastMock.success.mockClear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastingProbe />
      </QueryClientProvider>,
    );
  });
}

describe("the words in a realtime toast", () => {
  it("are this cabinet's, not the sentence the panel sent", () => {
    mount();
    expect(FakeEventSource.latest?.url).toBe("/api/v1/realtime/stream");

    act(() => {
      FakeEventSource.latest?.emit("subscription.created", {
        type: "subscription.created",
        category: "SUBSCRIPTION",
        severity: "INFO",
        // What an OLDER panel sends for this event, verbatim.
        message: "Remnawave profile created: rz_ivanov_vpn",
        metadata: {},
        timestamp: new Date().toISOString(),
      });
    });

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const said = String(toastMock.success.mock.calls[0]?.[0]);
    expect(said).not.toMatch(/remnawave|profile|rz_/i);
    expect(said.length).toBeGreaterThan(0);
  });

  it("say something different for a different event", () => {
    // Anti-coincidence anchor. One case above is satisfied by a hard-coded
    // string that simply is not the panel sentence; two different events must
    // produce two different cabinet sentences.
    mount();

    act(() => {
      FakeEventSource.latest?.emit("subscription.expired", {
        type: "subscription.expired",
        category: "SUBSCRIPTION",
        severity: "INFO",
        message: "Remnawave profile created: rz_ivanov_vpn",
        metadata: {},
        timestamp: new Date().toISOString(),
      });
      FakeEventSource.latest?.emit("subscription.created", {
        type: "subscription.created",
        category: "SUBSCRIPTION",
        severity: "INFO",
        message: "Remnawave profile created: rz_ivanov_vpn",
        metadata: {},
        timestamp: new Date().toISOString(),
      });
    });

    const said = toastMock.success.mock.calls.map((call) => String(call[0]));
    expect(said).toHaveLength(2);
    expect(new Set(said).size).toBe(2);
    for (const sentence of said) {
      expect(sentence).not.toMatch(/remnawave|profile|rz_/i);
    }
  });

  it("reach the customer at all when a device is unbound from the panel", () => {
    // The panel has sent `user_hwid_revoked` all along, and this cabinet
    // registered an SSE listener for every type in its query-key registry and
    // for nothing else. That type was not in it, and the browser dispatches a
    // NAMED event only on a matching listener — never on the generic `message`
    // handler — so every one of those frames was dropped. The neutral sentence
    // the panel added for it, and both translations of it, were unreachable.
    mount();

    act(() => {
      FakeEventSource.latest?.emit("user_hwid_revoked", {
        type: "user_hwid_revoked",
        category: "SUBSCRIPTION",
        severity: "INFO",
        message: "A device has been unlinked from your subscription",
        metadata: { hwid: "abc", remainingDevices: 2 },
        timestamp: new Date().toISOString(),
      });
    });

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(String(toastMock.success.mock.calls[0]?.[0])).not.toMatch(/^user_hwid/);
  });
});
