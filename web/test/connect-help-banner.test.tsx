// @vitest-environment jsdom

/**
 * «Не получилось подключиться?» — the banner on the dashboard.
 *
 * It is for the customer the panel could reach no other way — no bot, no push,
 * no verified e-mail — so the cabinet is the last channel left. Everything here
 * is about it appearing for exactly the right card and doing exactly what the
 * dashboard's own «Подключить» does:
 *
 *   - only when the panel raised it (`connectHelp.banner`) — an OLD panel sends
 *     no field and the dashboard must look exactly as it did;
 *   - only under the card on screen, between the card and its buttons;
 *   - × hides it at once and tells the panel, which records it;
 *   - «Подключить» goes through the operator's door: the cabinet's connect
 *     screen with the subscription named, or — switch off — the external page,
 *     opened by this tap, which is a gesture and may open a tab.
 *
 * The dashboard is real, with a real router; its heavy neighbours are stubbed.
 * The action row is real too, so the door behind both «Подключить» buttons is
 * the same code the customer runs.
 */
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getActionPolicy: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getSubscriptionDevices: vi.fn(),
  getConnectPage: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
}));
const subscriptionClient = vi.hoisted(() => ({ dismissConnectHelp: vi.fn() }));
const openExternalUrl = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: ComponentProps<"span">) => <span {...props}>{children}</span>,
  },
  useReducedMotion: () => true,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/api-client/subscription", () => subscriptionClient);
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/utils")>()),
  openExternalUrl,
}));
vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null }) }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa", logoUrl: null } }),
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false }),
}));
vi.mock("@/components/access-mode-banner", () => ({ AccessModeBanner: () => null }));
vi.mock("@/components/ui/reiwa-logo", () => ({ ReiwaLogo: () => null }));
vi.mock("@/features/push-prompt/push-prompt-card", () => ({ PushPromptCard: () => null }));
vi.mock("../src/features/dashboard/use-subscription-provisioning", () => ({
  useSubscriptionProvisioning: () => ({
    runtimes: [],
    completeHandoff: vi.fn(),
    startTrialProvisioning: vi.fn(),
  }),
}));
vi.mock("../src/features/dashboard/components/notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("../src/features/dashboard/components/quests-icon", () => ({ QuestsIcon: () => null }));
vi.mock("../src/features/dashboard/components/wheel-icon", () => ({ WheelIcon: () => null }));
vi.mock("../src/features/dashboard/components/empty-subscription-cta", () => ({
  EmptySubscriptionCta: () => null,
}));
vi.mock("../src/features/dashboard/components/trial-cta", () => ({ TrialCta: () => null }));
vi.mock("../src/features/dashboard/components/devices-list", () => ({ DevicesList: () => null }));
// One button per card, so a case can swipe; the active key is printed.
vi.mock("../src/features/dashboard/components/subscription-carousel", () => ({
  SubscriptionCarousel: ({
    items,
    activeItemKey,
    onActiveItemKeyChange,
  }: {
    readonly items: ReadonlyArray<{ readonly key: string }>;
    readonly activeItemKey: string | null;
    readonly onActiveItemKeyChange: (key: string) => void;
  }) => (
    <div data-testid="carousel" data-active={activeItemKey ?? ""}>
      {items.map((item) => (
        <button key={item.key} type="button" data-card={item.key} onClick={() => onActiveItemKeyChange(item.key)} />
      ))}
    </div>
  ),
}));

import DashboardPage from "../src/features/dashboard/dashboard-page";
import { subscriptionQueryKeys } from "../src/lib/subscription-query-keys";

const BANNER = { pending: true, banner: true } as const;

function subscription(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "ACTIVE",
    isTrial: false,
    userRemnaId: `rw_${id}`,
    url: `https://sub.example.test/${id}`,
    deviceLimit: 3,
    trafficLimit: null,
    expiresAt: "2026-12-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    plan: null,
    ...extra,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;
/** The router's `navigate`, from outside the page. */
let remote: NavigateFunction | null = null;

function Remote() {
  remote = useNavigate();
  return null;
}

function Where() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}

function where(): string {
  return container?.querySelector("[data-testid='where']")?.textContent ?? "";
}

async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Where />
          <Remote />
          <Routes>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="*" element={null} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function banner(): HTMLElement | null {
  return container?.querySelector<HTMLElement>("[data-testid='connect-help-banner']") ?? null;
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error("nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.history.replaceState(null, "", "/dashboard");
  api.getActionPolicy.mockResolvedValue({ canRenew: true });
  api.getSubscriptionDevices.mockResolvedValue({ devices: [], total: 0 });
  api.getSubscriptionAddOns.mockResolvedValue({ addOns: [] });
  // The switch's safe position: the external page.
  api.getConnectPage.mockResolvedValue(null);
  subscriptionClient.dismissConnectHelp.mockResolvedValue({ dismissed: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  remote = null;
  notifyManager.setScheduler(defaultScheduler);
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("when the banner appears", () => {
  it("appears when the panel raised it", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    expect(banner(), "no banner for a subscription the panel raised it for").not.toBeNull();
    expect(banner()?.textContent).toContain("connectHelp.bannerTitle");
    expect(banner()?.textContent).toContain("connectHelp.bannerBody");
  });

  it("does not appear for help sent through another channel", async () => {
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [subscription("sub_1", { connectHelp: { pending: true, banner: false } })],
    });
    await render();

    // Anti-vacuity: the dashboard is really on screen, with its buttons.
    expect(container?.querySelector("[data-connect-action]")).not.toBeNull();
    expect(banner()).toBeNull();
  });

  it("does not appear — and nothing breaks — on a panel older than the feature", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1")] });
    await render();

    expect(container?.querySelector("[data-connect-action]")).not.toBeNull();
    expect(banner()).toBeNull();
  });

  it("sits between the card and its buttons", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    const card = container?.querySelector("[data-tour='subscription-card']");
    const actions = container?.querySelector("[data-tour='subscription-actions']");
    expect(card?.nextElementSibling).toBe(banner());
    expect(banner()?.nextElementSibling).toBe(actions);
  });

  it("follows the card on screen, and only that card", async () => {
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [subscription("sub_1"), subscription("sub_2", { connectHelp: BANNER })],
    });
    await render();

    // The first card is on screen, and it connected long ago.
    expect(container?.querySelector("[data-testid='carousel']")?.getAttribute("data-active")).toBe(
      "subscription:sub_1",
    );
    expect(banner(), "a banner about another subscription under this card").toBeNull();

    click(container?.querySelector("[data-card='subscription:sub_2']"));
    expect(banner(), "the waiting card shows no banner").not.toBeNull();

    click(container?.querySelector("[data-card='subscription:sub_1']"));
    expect(banner()).toBeNull();
  });
});

describe("closing it", () => {
  it("hides it at once and tells the panel which subscription", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-testid='connect-help-dismiss']"));

    expect(banner(), "the banner stayed after ×").toBeNull();
    expect(subscriptionClient.dismissConnectHelp).toHaveBeenCalledTimes(1);
    expect(subscriptionClient.dismissConnectHelp).toHaveBeenCalledWith("sub_1");
  });

  it("stays closed when the customer swipes away and back", async () => {
    api.getAllSubscriptions.mockResolvedValue({
      subscriptions: [subscription("sub_1", { connectHelp: BANNER }), subscription("sub_2")],
    });
    await render();

    click(container?.querySelector("[data-testid='connect-help-dismiss']"));
    click(container?.querySelector("[data-card='subscription:sub_2']"));
    click(container?.querySelector("[data-card='subscription:sub_1']"));

    expect(banner()).toBeNull();
  });

  it("stays closed when the list is read again and still says so", async () => {
    // The panel did not record it (a failed write, a slow one): the next read
    // of the list still carries the banner. It must not come back mid-visit.
    subscriptionClient.dismissConnectHelp.mockRejectedValue(new Error("502"));
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-testid='connect-help-dismiss']"));
    const readsBefore = api.getAllSubscriptions.mock.calls.length;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all });
    });
    await settle();

    // Anti-vacuity: the list really was read again, and still said "banner".
    expect(api.getAllSubscriptions.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(banner()).toBeNull();
  });

  it("stays closed when the dashboard is opened again from the list it already holds", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-testid='connect-help-dismiss']"));
    await act(async () => {
      void remote?.("/settings");
    });
    await act(async () => {
      void remote?.("/dashboard");
    });
    await settle();

    // A fresh page, with nothing of its own remembered — only the cached list,
    // which the × corrected. Anti-vacuity: the dashboard is back on screen.
    expect(where()).toBe("/dashboard");
    expect(container?.querySelector("[data-connect-action]")).not.toBeNull();
    expect(banner()).toBeNull();
  });

  it("stays closed for this visit when the panel could not record it", async () => {
    subscriptionClient.dismissConnectHelp.mockRejectedValue(new Error("502"));
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-testid='connect-help-dismiss']"));
    await settle();

    expect(subscriptionClient.dismissConnectHelp).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    // The page is still whole.
    expect(container?.querySelector("[data-connect-action]")).not.toBeNull();
  });
});

describe("its «Подключить»", () => {
  it("opens the cabinet's connect screen for this subscription when the switch is on", async () => {
    api.getConnectPage.mockResolvedValue({ connectScreenEnabled: true });
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-testid='connect-help-connect']"));

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_1");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens the subscription page on the tap when the switch is off", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-testid='connect-help-connect']"));

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith("https://sub.example.test/sub_1");
    expect(where()).toBe("/dashboard");
  });

  it("does exactly what the card's own «Подключить» does", async () => {
    api.getConnectPage.mockResolvedValue({ connectScreenEnabled: true });
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-connect-action]"));

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_1");
  });

  it("«Написать в поддержку» opens support", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [subscription("sub_1", { connectHelp: BANNER })] });
    await render();

    click(container?.querySelector("[data-testid='connect-help-support']"));

    expect(where()).toBe("/support");
  });
});
