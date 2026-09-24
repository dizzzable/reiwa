// @vitest-environment jsdom

/**
 * The dashboard hands the card's buttons the panel's word that the subscription
 * on screen has no end date (the owner, 24.09.2026: it stays without one).
 *
 * The subscription list shows the VPN panel's date for such a subscription, so
 * the card cannot tell by itself: without this word «Продлить» is only greyed
 * out with nothing said, where the panel knows the reason. The buttons
 * themselves are pinned in `subscription-actions.test.tsx`; this is the wire
 * from the policy to them. Harness as in `dashboard-buy-beside-trial.test.tsx`.
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
const actions = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
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
  SubscriptionActions: (props: Record<string, unknown>) => {
    actions.props.push(props);
    return null;
  },
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

/** A paid subscription as the list gives it: with the VPN panel's date, whatever the panel's own row says. */
const SUBSCRIPTION = {
  id: "sub-lifetime",
  isTrial: false,
  status: "ACTIVE",
  url: "https://example.test/sub",
  deviceLimit: 3,
  trafficLimit: 100,
  expiresAt: "2026-12-01T00:00:00.000Z",
  remnawaveId: "rw_1",
  planName: "Standard",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
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

/** What the card's buttons were last told about the subscription on screen. */
function lastActions(): Record<string, unknown> {
  const onScreen = actions.props.filter(
    (props) => (props["subscription"] as { id?: string } | null)?.id === SUBSCRIPTION.id,
  );
  const last = onScreen[onScreen.length - 1];
  if (last === undefined) throw new Error("the buttons were never drawn for the subscription on screen");
  return last;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  actions.props = [];
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [SUBSCRIPTION] });
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

describe("DashboardPage and a subscription with no end date", () => {
  it("hands the buttons the panel's word that it has none", async () => {
    api.getActionPolicy.mockImplementation(async (subscriptionId?: string) =>
      subscriptionId === SUBSCRIPTION.id
        ? { canRenew: false, canBuy: false, canUpgrade: true, canTrial: false, lifetime: true }
        : { canRenew: false, canBuy: false, canUpgrade: false, canTrial: false },
    );

    render();
    await settle();

    expect(lastActions()["policyCanRenew"]).toBe(false);
    expect(lastActions()["policyLifetime"]).toBe(true);
  });

  it("control: a panel that says nothing of the kind leaves the word out", async () => {
    api.getActionPolicy.mockResolvedValue({ canRenew: true, canBuy: false, canUpgrade: true, canTrial: false });

    render();
    await settle();

    expect(lastActions()["policyCanRenew"]).toBe(true);
    expect(lastActions()["policyLifetime"]).toBeUndefined();
  });
});
