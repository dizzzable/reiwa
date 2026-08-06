// @vitest-environment jsdom

/**
 * DevicesPage — "we could not check" must never render as "you have none".
 *
 * The page used to branch `isLoading → skeletons`, then `!devices.length →
 * empty card`. A failed read leaves `data` undefined, so `devices` fell back
 * to `[]` and an outage rendered the friendly empty state, under a header
 * claiming a device count. rezeis-admin now fails the read (503/502) and
 * reiwa's BFF forwards it; these specs pin what the customer sees.
 */

import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getUserDevices: vi.fn(),
  deleteUserDevice: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null }) }));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button">back</button>,
}));

import DevicesPage from "../src/features/subscription/devices-page";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const DEVICE = {
  hwid: "hwid-abcdef123456",
  platform: "android",
  osVersion: "14",
  deviceModel: "Pixel 8",
  userAgent: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  lastSeenAt: "2026-08-05T10:00:00.000Z",
};

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function render(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <DevicesPage />
      </QueryClientProvider>,
    );
  });
}

function retryButton(): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent?.includes("common.retry"),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React Query defers every observer notification onto a real
  // `setTimeout(…, 0)`, registered while the settled query promise drains its
  // microtasks — i.e. AFTER the timer `settle()` has already registered for its
  // own wakeup. Both are 0 ms, so they share a timer phase only while that
  // drain stays inside one millisecond. Under the load of a full-suite run it
  // does not: the act scope wakes, finds an empty queue and resolves before the
  // failure state ever reached the tree, and this spec asserted against a
  // still-loading page. It failed exactly that way in a full run while passing
  // in isolation. Microtasks always drain ahead of timers, so scheduling
  // notifications on them puts the re-render inside the open act scope
  // regardless of the wall clock. Same fix, same reason, as
  // `privacy-page-deep-link.test.tsx`.
  notifyManager.setScheduler(queueMicrotask);
  // `clearAllMocks` keeps queued `...Once` values, so an unconsumed one would
  // leak into the next spec and quietly change what it asserts against.
  api.getUserDevices.mockReset();
  api.deleteUserDevice.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  notifyManager.setScheduler(defaultScheduler);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DevicesPage device read", () => {
  it("renders the failure state and NOT the empty state when the read fails", async () => {
    api.getUserDevices.mockRejectedValue(new Error("Request failed with status code 503"));
    render();
    await settle();

    // Self-check: the mock really did reject, so this spec cannot pass by
    // never reaching the failure branch at all.
    expect(api.getUserDevices).toHaveBeenCalledTimes(1);
    expect(text()).toContain("devices.loadFailedTitle");
    expect(text()).toContain("devices.loadFailedBody");
    expect(text()).not.toContain("devices.emptyTitle");
    expect(text()).not.toContain("devices.emptyHint");
    expect(retryButton()).toBeTruthy();
  });

  it("shows no device count on a failed read", async () => {
    api.getUserDevices.mockRejectedValue(new Error("Request failed with status code 503"));
    render();
    await settle();

    expect(text()).toContain("devices.countUnavailable");
    // `connectedCount` is the interpolated "{{count}} connected" header. A
    // failed read must not produce it at all — not even with a 0.
    expect(text()).not.toContain("devices.connectedCount");
  });

  it("retry refetches the device list", async () => {
    api.getUserDevices.mockRejectedValueOnce(new Error("503"));
    render();
    await settle();
    expect(api.getUserDevices).toHaveBeenCalledTimes(1);

    api.getUserDevices.mockResolvedValueOnce({ devices: [DEVICE], total: 1 });
    const button = retryButton();
    expect(button).toBeTruthy();
    act(() => button?.click());
    await settle();

    expect(api.getUserDevices).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("devices.loadFailedTitle");
    // `deviceName ?? platform` — the panel projection sends `deviceModel`, not
    // `deviceName`, so this page has always shown the platform. Asserted as-is
    // because changing it would change a SUCCESSFUL read's rendering.
    expect(text()).toContain("android");
  });

  it("still renders the friendly empty state for a genuinely empty list", async () => {
    api.getUserDevices.mockResolvedValue({ devices: [], total: 0 });
    render();
    await settle();

    expect(text()).toContain("devices.emptyTitle");
    expect(text()).toContain("devices.emptyHint");
    expect(text()).not.toContain("devices.loadFailedTitle");
    expect(retryButton()).toBeUndefined();
  });

  it("renders a successful list unchanged", async () => {
    api.getUserDevices.mockResolvedValue({ devices: [DEVICE], total: 1 });
    render();
    await settle();

    // Same expression the page has always used: deviceName ?? platform.
    expect(text()).toContain("android");
    expect(text()).toContain("hwid-abcdef1");
    expect(text()).toContain("devices.lastSeenLabel");
    expect(text()).not.toContain("devices.emptyTitle");
    expect(text()).not.toContain("devices.loadFailedTitle");
    expect(text()).not.toContain("devices.countUnavailable");
  });
});
