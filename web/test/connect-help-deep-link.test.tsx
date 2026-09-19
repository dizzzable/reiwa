// @vitest-environment jsdom

/**
 * `/dashboard?connect=help[&subscriptionId=…]` — where a push click, the bot's
 * «Подключить», the notification feed and the pop-up all land.
 *
 * The handler picks the card (the one named, else the newest still waiting for
 * help, else the one on screen) and then opens the operator's door for it:
 *
 *   INTERNAL — the cabinet's connect screen, with the subscription named. A
 *   navigation; it needs no gesture.
 *
 *   EXTERNAL — never opened from here. The page was opened BY the link, so
 *   there is no tap on the stack and a new tab is a blocked pop-up — this
 *   cabinet already lost payments to exactly that. «Подключить» is ringed,
 *   scrolled to and focused instead, and the customer's own tap opens it.
 *
 * And it must not decide before it knows: not before the subscription list,
 * not before the switch. The address loses the link as it is read, so Back and
 * a reload never run it twice.
 *
 * The dashboard is real, in a real `BrowserRouter` (the app's router — whose
 * location IS the address bar, which is what the handler reads).
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
import type { MockInstance } from "vitest";

const api = vi.hoisted(() => ({
  getActionPolicy: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getSubscriptionDevices: vi.fn(),
  getConnectPage: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
}));
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
vi.mock("@/lib/api-client/subscription", () => ({ dismissConnectHelp: vi.fn(async () => ({ dismissed: true })) }));
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
vi.mock("../src/features/dashboard/components/subscription-carousel", () => ({
  SubscriptionCarousel: ({ activeItemKey }: { readonly activeItemKey: string | null }) => (
    <div data-testid="carousel" data-active={activeItemKey ?? ""} />
  ),
}));

import DashboardPage from "../src/features/dashboard/dashboard-page";
import { rememberDashboardCache } from "../src/features/dashboard/connect-door";
import { runHintCta } from "../src/features/hints/hint-cta";

function subscription(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "ACTIVE",
    isTrial: false,
    userRemnaId: `rw_${id}`,
    url: `https://sub.example.test/${id}`,
    deviceLimit: 3,
    trafficLimit: null,
    expiresAt: "2026-12-01T00:00:00.000Z",
    createdAt,
    plan: null,
    ...extra,
  };
}

const PENDING = { pending: true, banner: false } as const;

/** Three cards: the first connected long ago, the other two still waiting. */
const THREE = [
  subscription("sub_1", "2026-06-01T00:00:00.000Z", { connectHelp: null }),
  subscription("sub_2", "2026-08-01T00:00:00.000Z", { connectHelp: PENDING }),
  subscription("sub_3", "2026-09-10T00:00:00.000Z", { connectHelp: PENDING }),
];

/** What an OLD panel sends: the same cards, no `connectHelp` at all. */
const OLD_PANEL = [
  subscription("sub_1", "2026-06-01T00:00:00.000Z"),
  subscription("sub_2", "2026-08-01T00:00:00.000Z"),
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let windowOpen: MockInstance<typeof window.open>;
/** The router's `navigate`, from outside the page — a push click with the dashboard open. */
let remote: NavigateFunction | null = null;

function Where() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}

function Remote() {
  remote = useNavigate();
  return null;
}

function where(): string {
  return container?.querySelector("[data-testid='where']")?.textContent ?? "";
}

function activeCard(): string {
  return container?.querySelector("[data-testid='carousel']")?.getAttribute("data-active") ?? "";
}

function connectButton(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>("[data-connect-action]") ?? null;
}

async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Long enough for the animation frame the dashboard scrolls and focuses in. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  });
}

async function openAt(address: string): Promise<void> {
  window.history.replaceState(null, "", address);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
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

function internalDoor(): void {
  api.getConnectPage.mockResolvedValue({ connectScreenEnabled: true });
}

function externalDoor(): void {
  api.getConnectPage.mockResolvedValue({ connectScreenEnabled: false });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  api.getActionPolicy.mockResolvedValue({ canRenew: true });
  api.getSubscriptionDevices.mockResolvedValue({ devices: [], total: 0 });
  api.getSubscriptionAddOns.mockResolvedValue({ addOns: [] });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: THREE });
  windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  remote = null;
  rememberDashboardCache(null);
  notifyManager.setScheduler(defaultScheduler);
  window.history.replaceState(null, "", "/");
  windowOpen.mockRestore();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the internal door", () => {
  it("opens the connect screen for the card the link named", async () => {
    internalDoor();
    await openAt("/dashboard?connect=help&subscriptionId=sub_2");

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_2");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("picks the newest card still waiting when the link names none", async () => {
    internalDoor();
    await openAt("/dashboard?connect=help");

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_3");
  });

  it("picks the newest waiting card when the named one is gone", async () => {
    internalDoor();
    await openAt("/dashboard?connect=help&subscriptionId=deleted_since");

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_3");
  });

  it("falls back to the card on screen on a panel older than the feature", async () => {
    internalDoor();
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: OLD_PANEL });
    await openAt("/dashboard?connect=help");

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_1");
  });

  it("leaves no link behind: Back returns to a plain dashboard that stays put", async () => {
    internalDoor();
    await openAt("/dashboard?connect=help&subscriptionId=sub_2");
    expect(where()).toBe("/subscription/connect?subscriptionId=sub_2");

    await act(async () => {
      window.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    // Back lands on the dashboard — without the link, so it does not send the
    // customer forward again and trap them. The page itself is on screen, so
    // "stayed put" is the dashboard staying, not an empty route.
    expect(where()).toBe("/dashboard");
    expect(connectButton()).not.toBeNull();
  });
});

describe("the external door", () => {
  it("never opens anything by itself — it points at «Подключить» on the chosen card", async () => {
    externalDoor();
    await openAt("/dashboard?connect=help&subscriptionId=sub_2");
    await frame();

    expect(openExternalUrl, "the external page was opened without a tap").not.toHaveBeenCalled();
    expect(windowOpen, "a window was opened without a tap").not.toHaveBeenCalled();
    expect(activeCard()).toBe("subscription:sub_2");
    expect(connectButton()?.hasAttribute("data-highlighted"), "«Подключить» is not pointed at").toBe(true);
    expect(document.activeElement).toBe(connectButton());
    expect(container?.querySelector("[data-testid='connect-highlight-note']")?.textContent).toBe(
      "connectHelp.tapConnect",
    );
    // The link has left the address.
    expect(where()).toBe("/dashboard");
  });

  it("lets the customer's own tap open that card's page", async () => {
    externalDoor();
    await openAt("/dashboard?connect=help&subscriptionId=sub_2");

    act(() => {
      connectButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith("https://sub.example.test/sub_2");
    // Done pointing once it was pressed.
    expect(connectButton()?.hasAttribute("data-highlighted")).toBe(false);
  });

  it("treats a failed read of the switch as the external page — and still opens nothing", async () => {
    api.getConnectPage.mockRejectedValue(new Error("panel down"));
    await openAt("/dashboard?connect=help");

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(activeCard()).toBe("subscription:sub_3");
    expect(connectButton()?.hasAttribute("data-highlighted")).toBe(true);
  });
});

describe("waiting for what it needs", () => {
  it("does nothing until the operator's switch has been read", async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.getConnectPage.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openAt("/dashboard?connect=help&subscriptionId=sub_2");

    // Not "external" by default: nothing ringed, nothing opened, no screen.
    expect(where()).toBe("/dashboard");
    expect(connectButton()?.hasAttribute("data-highlighted")).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();

    await act(async () => {
      answer({ connectScreenEnabled: true });
    });
    await settle();

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_2");
  });
});

describe("a link that arrives while the dashboard is already open", () => {
  it("is handled — a push clicked with the cabinet on screen", async () => {
    internalDoor();
    await openAt("/dashboard");
    expect(where()).toBe("/dashboard");

    await act(async () => {
      void remote?.("/dashboard?connect=help&subscriptionId=sub_2");
    });
    await settle();

    expect(where()).toBe("/subscription/connect?subscriptionId=sub_2");
  });

  it("is handled on the external door too, on the card it named", async () => {
    externalDoor();
    await openAt("/dashboard");
    expect(activeCard()).toBe("subscription:sub_1");

    await act(async () => {
      void remote?.("/dashboard?connect=help&subscriptionId=sub_2");
    });
    await settle();

    expect(activeCard()).toBe("subscription:sub_2");
    expect(connectButton()?.hasAttribute("data-highlighted")).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});

describe("a dashboard opened without the link", () => {
  it("does none of this", async () => {
    internalDoor();
    await openAt("/dashboard");

    expect(where()).toBe("/dashboard");
    expect(activeCard()).toBe("subscription:sub_1");
    expect(connectButton()?.hasAttribute("data-highlighted")).toBe(false);
  });
});

describe("the pop-up's «Подключить» once the dashboard has been open", () => {
  const POPUP = {
    deliveryId: "d1",
    key: "tpl-connect-help",
    mode: "MODAL",
    tone: "INFO",
    title: "Не получилось подключиться?",
    body: "…",
    ctaKind: "ROUTE",
    ctaLabel: "Подключить",
    ctaTarget: "@connect",
  } as const;

  it("uses what the dashboard read: straight to the screen for the waiting card", async () => {
    internalDoor();
    await openAt("/dashboard");
    const tap = vi.fn();

    runHintCta(POPUP, tap as never);

    // Not the deep link: the dashboard handed its cache over, so the door
    // already knows the switch and which subscription is waiting.
    expect(tap.mock.calls).toEqual([["/subscription/connect?subscriptionId=sub_3"]]);
  });

  it("opens the waiting card's page inside the tap when the switch is off", async () => {
    externalDoor();
    await openAt("/dashboard");
    const tap = vi.fn();

    runHintCta(POPUP, tap as never);

    expect(openExternalUrl).toHaveBeenCalledWith("https://sub.example.test/sub_3");
    expect(tap).not.toHaveBeenCalled();
  });
});
