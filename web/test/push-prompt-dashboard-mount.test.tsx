// @vitest-environment jsdom

/**
 * The dashboard carries the push prompt, inline, right under the action
 * buttons of the subscription on screen — and draws nothing for it until the
 * card's own conditions hold.
 *
 * The harness is `dashboard-devices-load-failure.test.tsx`'s: the dashboard is
 * real, its heavy neighbours are stubbed. The card is the real one, in a
 * browser stubbed to take push.
 */

import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  getPushPublicKey: vi.fn(),
  pushSubscribe: vi.fn(),
  pushUnsubscribe: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
vi.mock("../src/features/dashboard/use-subscription-provisioning", () => ({
  useSubscriptionProvisioning: () => ({ runtimes: [], completeHandoff: vi.fn(), startTrialProvisioning: vi.fn() }),
}));
vi.mock("../src/features/dashboard/components/notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("../src/features/dashboard/components/quests-icon", () => ({ QuestsIcon: () => null }));
vi.mock("../src/features/dashboard/components/wheel-icon", () => ({ WheelIcon: () => null }));
vi.mock("../src/features/dashboard/components/empty-subscription-cta", () => ({ EmptySubscriptionCta: () => null }));
vi.mock("../src/features/dashboard/components/trial-cta", () => ({ TrialCta: () => null }));
vi.mock("../src/features/dashboard/components/subscription-actions", () => ({
  SubscriptionActions: () => <div data-testid="actions" />,
}));
vi.mock("../src/features/dashboard/components/subscription-carousel", () => ({
  SubscriptionCarousel: () => <div data-testid="carousel" />,
}));
vi.mock("../src/features/dashboard/components/devices-list", () => ({ DevicesList: () => <div data-testid="devices" /> }));

import DashboardPage from "../src/features/dashboard/dashboard-page";
import {
  markPushPromptEligible,
  resetPushPromptMemoryForTests,
} from "../src/features/push-prompt/push-prompt-storage";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(ticks = 8): Promise<void> {
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetPushPromptMemoryForTests();
  api.getAllSubscriptions.mockResolvedValue({
    subscriptions: [{ id: "sub_1", status: "ACTIVE", url: "https://example.test/sub", deviceLimit: 3 }],
  });
  api.getActionPolicy.mockResolvedValue({ canRenew: true });
  api.getSubscriptionDevices.mockResolvedValue({ devices: [], total: 0 });
  api.getPushPublicKey.mockResolvedValue({ publicKey: KEY });
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "granted") });
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null, subscribe: vi.fn() } }) },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({ matches: false, media, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  notifyManager.setScheduler(defaultScheduler);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("the dashboard and the push prompt", () => {
  it("shows the card right under the action buttons after a purchase", async () => {
    markPushPromptEligible();
    render();
    await settle();

    const prompt = container?.querySelector("[data-testid='push-prompt']");
    expect(prompt, "the dashboard does not carry the prompt").not.toBeNull();
    expect(prompt?.textContent).toContain("pushPrompt.text");
    const actions = container?.querySelector("[data-tour='subscription-actions']");
    expect(actions?.nextElementSibling, "the prompt is not under the action buttons").toBe(prompt);
  });

  it("draws nothing for it without a purchase — while the dashboard itself is on screen", async () => {
    render();
    await settle();

    expect(container?.querySelector("[data-testid='actions']")).not.toBeNull();
    expect(container?.querySelector("[data-testid='push-prompt']")).toBeNull();
    expect(api.getPushPublicKey).not.toHaveBeenCalled();
  });
});
