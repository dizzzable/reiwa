// @vitest-environment jsdom

/**
 * DashboardPage device read — the two places the dashboard can lie.
 *
 * 1. `DevicesList` fell through to the "no devices" card whenever the read
 *    produced no rows, failure included.
 * 2. The subscription CARD carries a device slot fed by `firstDeviceById`. A
 *    failed read made it `null`, which the card renders as `card.noDevicesYet`
 *    — the same "you have none" claim in a smaller space.
 *
 * The carousel is stubbed to print the slot it was handed, so this spec fails
 * if the dashboard stops computing that slot honestly; `DevicesList` is the
 * REAL component, so it fails if the failure branch is removed there.
 */

import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getActionPolicy: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getSubscriptionDevices: vi.fn(),
  deleteSubscriptionDevice: vi.fn(),
  regenerateSubscriptionLink: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: ComponentProps<"span">) => <span {...props}>{children}</span>,
  },
  useReducedMotion: () => true,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null }) }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa", logoUrl: null } }),
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false }),
}));
vi.mock("@/components/access-mode-banner", () => ({ AccessModeBanner: () => null }));
vi.mock("@/components/ui/reiwa-logo", () => ({ ReiwaLogo: () => null }));
vi.mock("@/features/dashboard/use-subscription-provisioning", () => ({
  useSubscriptionProvisioning: () => ({
    runtimes: [],
    completeHandoff: vi.fn(),
    startTrialProvisioning: vi.fn(),
  }),
}));
vi.mock("../src/features/dashboard/use-subscription-provisioning", () => ({
  useSubscriptionProvisioning: () => ({
    runtimes: [],
    completeHandoff: vi.fn(),
    startTrialProvisioning: vi.fn(),
  }),
}));
vi.mock("../src/features/dashboard/components/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("../src/features/dashboard/components/quests-icon", () => ({
  QuestsIcon: () => null,
}));
// Stubbed like every other header widget: this file is about the device
// card, and a real wheel icon would need `getWheel` on the api mock.
vi.mock("../src/features/dashboard/components/wheel-icon", () => ({
  WheelIcon: () => null,
}));
vi.mock("../src/features/dashboard/components/empty-subscription-cta", () => ({
  EmptySubscriptionCta: () => null,
}));
vi.mock("../src/features/dashboard/components/trial-cta", () => ({
  TrialCta: () => null,
}));
vi.mock("../src/features/dashboard/components/subscription-actions", () => ({
  SubscriptionActions: () => null,
}));
// Stands in for the real carousel so the device slot the dashboard computes is
// observable as text. `card.noDevicesYet` is what the real card renders for a
// `null` slot — see `subscription-card.tsx`.
vi.mock("../src/features/dashboard/components/subscription-carousel", () => ({
  SubscriptionCarousel: ({
    firstDeviceById,
  }: {
    readonly firstDeviceById: Record<string, string | null>;
  }) => (
    <div data-testid="card-device-slot">
      {Object.values(firstDeviceById)
        .map((slot) => slot ?? "card.noDevicesYet")
        .join(",")}
    </div>
  ),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
}));

import DashboardPage from "../src/features/dashboard/dashboard-page";

const SUBSCRIPTION = {
  id: "sub_1",
  status: "ACTIVE",
  url: "https://example.test/sub",
  deviceLimit: 3,
  trafficLimit: 100,
  expiresAt: "2026-12-01T00:00:00.000Z",
  remnawaveId: "rw_1",
  planName: "Standard",
};

const DEVICE = {
  hwid: "hwid-abcdef123456",
  platform: "android",
  osVersion: "14",
  deviceModel: "Pixel 8",
  userAgent: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  lastSeenAt: "2026-08-05T10:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/**
 * The device query is gated on `activeSubscriptionId`, which only exists after
 * the subscriptions query resolves — two chained resolutions, so one macrotask
 * is not always enough. Flush a few.
 */
async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(): string {
  return container?.textContent ?? "";
}

function cardSlot(): string {
  return (
    container?.querySelector('[data-testid="card-device-slot"]')?.textContent ?? ""
  );
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
        <DashboardPage />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React Query defers observer notifications onto a real `setTimeout(…, 0)`
  // registered AFTER the one the settle helper is already waiting on. Both are
  // 0 ms, so they share a phase only while the promise drain stays inside one
  // millisecond — and under full-suite load it does not, leaving the act scope
  // to resolve against a still-loading tree. The sibling spec
  // `devices-page-load-failure.test.tsx` failed exactly that way in a full run
  // while passing in isolation. Microtasks drain ahead of timers, so this puts
  // the re-render inside the open act scope regardless of the wall clock.
  notifyManager.setScheduler(queueMicrotask);
  api.getAllSubscriptions.mockReset();
  api.getActionPolicy.mockReset();
  api.getSubscriptionDevices.mockReset();
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [SUBSCRIPTION] });
  api.getActionPolicy.mockResolvedValue({ canRenew: true });
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

describe("DashboardPage device read", () => {
  it("renders the failure card, not the empty card, when the read fails", async () => {
    api.getSubscriptionDevices.mockRejectedValue(
      new Error("Request failed with status code 503"),
    );
    render();
    await settle();

    // Self-check: the read really was attempted and really did reject.
    expect(api.getSubscriptionDevices).toHaveBeenCalled();
    expect(text()).toContain("devices.loadFailedTitle");
    expect(text()).not.toContain("devices.empty");
  });

  it("does not claim the card has no devices when the read fails", async () => {
    api.getSubscriptionDevices.mockRejectedValue(
      new Error("Request failed with status code 503"),
    );
    render();
    await settle();

    expect(cardSlot()).toBe("card.devicesUnavailable");
    expect(cardSlot()).not.toContain("card.noDevicesYet");
  });

  it("still shows the empty card for a genuinely empty list", async () => {
    api.getSubscriptionDevices.mockResolvedValue({ devices: [], total: 0 });
    render();
    await settle();

    expect(text()).toContain("devices.empty");
    expect(text()).not.toContain("devices.loadFailedTitle");
    // A real empty list keeps the card's honest "no devices yet" slot.
    expect(cardSlot()).toBe("card.noDevicesYet");
  });

  it("renders a successful list unchanged", async () => {
    api.getSubscriptionDevices.mockResolvedValue({ devices: [DEVICE], total: 1 });
    render();
    await settle();

    expect(text()).toContain("Pixel 8");
    expect(text()).not.toContain("devices.loadFailedTitle");
    expect(text()).not.toContain("devices.empty");
    expect(cardSlot()).toBe("Pixel 8");
  });

  it("retry refetches instead of leaving the customer stuck", async () => {
    api.getSubscriptionDevices.mockRejectedValueOnce(new Error("503"));
    render();
    await settle();
    const callsAfterFailure = api.getSubscriptionDevices.mock.calls.length;
    expect(callsAfterFailure).toBeGreaterThan(0);

    api.getSubscriptionDevices.mockResolvedValueOnce({ devices: [DEVICE], total: 1 });
    const button = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (candidate) => candidate.textContent?.includes("common.retry"),
    );
    expect(button).toBeTruthy();
    act(() => button?.click());
    await settle();

    expect(api.getSubscriptionDevices.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(text()).not.toContain("devices.loadFailedTitle");
    expect(text()).toContain("Pixel 8");
  });
});
