// @vitest-environment jsdom

/**
 * The dashboard's «Купить» beside a trial.
 *
 * Buying beside a trial converts it (`lib/trial-conversion`), which takes no
 * free slot. Without multi-subscription every trial holder is "full", and the
 * header button refused them with «лимит подписок» — a dead end for the one
 * purchase that was theirs to make. It now opens the catalogue, which offers
 * what the trial can become. A full account without a trial is still refused.
 *
 * The header widgets and the carousel are stubbed as in
 * `dashboard-devices-load-failure.test.tsx`; the button is the real one.
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
  getConnectPage: vi.fn().mockResolvedValue(null),
}));
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: ComponentProps<"span">) => <span {...props}>{children}</span>,
  },
  useReducedMotion: () => true,
}));
vi.mock("sonner", () => ({ toast }));
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
vi.mock("../src/features/dashboard/components/quests-icon", () => ({ QuestsIcon: () => null }));
vi.mock("../src/features/dashboard/components/wheel-icon", () => ({ WheelIcon: () => null }));
vi.mock("../src/features/dashboard/components/empty-subscription-cta", () => ({
  EmptySubscriptionCta: () => null,
}));
vi.mock("../src/features/dashboard/components/trial-cta", () => ({ TrialCta: () => null }));
vi.mock("../src/features/dashboard/components/subscription-actions", () => ({
  SubscriptionActions: () => null,
}));
vi.mock("../src/features/dashboard/components/subscription-carousel", () => ({
  SubscriptionCarousel: () => null,
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

function subscription(id: string, isTrial: boolean) {
  return {
    id,
    isTrial,
    status: "ACTIVE",
    url: "https://example.test/sub",
    deviceLimit: 3,
    trafficLimit: 100,
    expiresAt: "2026-12-01T00:00:00.000Z",
    remnawaveId: "rw_1",
    planName: isTrial ? "Trial" : "Standard",
  };
}

/** One subscription, one allowed: what every account is without multi-subscription. */
const FULL = { canRenew: false, canBuy: false, limitReached: true, activeSubscriptionCount: 1, maxSubscriptions: 1 };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buyButton(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>('button[aria-label="card.actions.buy"]') ?? null;
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
  notifyManager.setScheduler(queueMicrotask);
  api.getActionPolicy.mockResolvedValue(FULL);
  api.getSubscriptionDevices.mockResolvedValue({ devices: [], total: 0 });
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

describe("DashboardPage «Купить» at the limit", () => {
  it("opens the catalogue for a trial holder, who buys by converting the trial", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("trial", true)] });
    render();
    await settle();

    const buy = buyButton();
    expect(buy).not.toBeNull();
    expect(buy?.title ?? "").not.toContain("subscription.limitReached");
    act(() => buy?.click());

    expect(toast.warning).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/plans");
  });

  it("still refuses a full account without a trial", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("paid", false)] });
    render();
    await settle();

    act(() => buyButton()?.click());

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalledWith("/plans");
  });
});
