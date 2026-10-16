// @vitest-environment jsdom

/**
 * THE GUIDED WALK, END TO END, AS A CUSTOMER WOULD TAP IT.
 *
 * The pure rules have their own tests (`connect-wizard-model.test.ts`,
 * `connect-connection-watch.test.ts`). This one holds the screens to them:
 * that two subscriptions open on the choice, on the card that was tapped; that
 * the steps follow one another; that «Добавить» carries the subscription the
 * customer chose; and that the walk finishes BY ITSELF when the panel says the
 * profile came online — or asks the customer when it cannot tell.
 *
 * Motion is replaced with plain elements: jsdom runs no animation frames, and
 * an exit that never finishes would hold every next step back forever. The
 * home screen's card is replaced too — it is a WebGL surface with tests of its
 * own, and here it only has to say which subscription it is.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = Date.parse("2026-10-16T12:00:00.000Z");

const CATALOG = {
  connectScreenEnabled: true,
  connectScreenMode: "interactive",
  featuredColor: null,
  platforms: [
    {
      id: "windows",
      title: { ru: "Windows" },
      iconKey: null,
      apps: [
        {
          id: "happ",
          name: "Happ",
          iconKey: "happ",
          featured: true,
          steps: [
            {
              title: { ru: "Установка" },
              body: null,
              iconKey: null,
              buttons: [{ kind: "external", label: { ru: "Скачать" }, url: "https://get.test/happ.exe" }],
            },
            {
              title: { ru: "Добавление" },
              body: null,
              iconKey: null,
              buttons: [
                { kind: "deepLink", label: { ru: "Добавить" }, template: "happ://add/{{SUBSCRIPTION_LINK}}", encode: "raw" },
              ],
            },
            { title: { ru: "Подключение" }, body: { ru: "Нажмите большую кнопку." }, iconKey: null, buttons: [] },
          ],
        },
        {
          id: "koala",
          name: "Koala",
          iconKey: null,
          featured: false,
          steps: [
            {
              title: { ru: "Добавьте" },
              body: null,
              iconKey: null,
              buttons: [{ kind: "copyLink", label: { ru: "Скопировать" } }],
            },
          ],
        },
      ],
    },
    {
      id: "android",
      title: { ru: "Android" },
      iconKey: null,
      apps: [
        {
          id: "v2",
          name: "v2RayTun",
          iconKey: null,
          featured: true,
          steps: [
            {
              title: { ru: "Добавьте" },
              body: null,
              iconKey: null,
              buttons: [{ kind: "copyLink", label: { ru: "Скопировать" } }],
            },
          ],
        },
      ],
    },
  ],
  icons: { happ: "<svg viewBox='0 0 1 1'></svg>" },
  theme: null,
};

function subscription(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "ACTIVE",
    isTrial: false,
    profileName: `rz_${id}`,
    url: `https://sub.test/${id}`,
    connectSignature: "sig",
    expiresAt: "2026-12-01T00:00:00.000Z",
    trafficUsed: 1,
    trafficLimit: 100,
    deviceLimit: 3,
    userRemnaId: null,
    plan: { id: null, name, type: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

let subscriptionsPayload: unknown;
let searchParams = new URLSearchParams();
/** What each `/subscription/:id/connection` call answers, in order; the last one repeats. */
let connectionAnswers: unknown[] = [];
const navigate = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key}|${JSON.stringify(options)}`,
    i18n: { language: "ru" },
  }),
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [searchParams, vi.fn()],
  useNavigate: () => navigate,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data:
      queryKey[0] === "connect-page"
        ? CATALOG
        : queryKey[0] === "devices"
          ? { devices: [], total: 1 }
          : subscriptionsPayload,
    isLoading: false,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client", () => ({
  getAllSubscriptions: vi.fn(),
  getConnectPage: vi.fn(),
  getSubscriptionDevices: vi.fn(),
}));
const getSubscriptionConnection = vi.fn((_id: string) => {
  const next = connectionAnswers.length > 1 ? connectionAnswers.shift() : connectionAnswers[0];
  return Promise.resolve(next);
});
vi.mock("@/lib/api-client/subscription", () => ({
  getSubscriptionConnection: (id: string) => getSubscriptionConnection(id),
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({
    branding: { brandName: "d3MVpn", logoUrl: null, navItems: [{ id: "support", visible: true }] },
    themeMode: "dark",
    customIcons: [],
  }),
}));
vi.mock("@/components/ui/brand-logo", () => ({ BrandLogo: () => <span /> }));
vi.mock("@/features/dashboard/components/subscription-card", () => ({
  SubscriptionCard: ({ subscription, index }: { subscription: { id: string }; index: number }) => (
    <div data-card={subscription.id} data-card-index={index} />
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("motion/react", async () => {
  const React = await import("react");
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, transition, custom, ...rest } = props;
    void initial;
    void animate;
    void exit;
    void transition;
    void custom;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef<HTMLElement, Record<string, unknown>>(function Plain(props, ref) {
          return React.createElement(tag, { ...strip(props), ref });
        }),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});

const { default: ConnectWizard } = await import("../src/features/connect/wizard/connect-wizard");

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ConnectWizard />);
  });
  await settle();
}

/** Lets the mocked network and React's effects run. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function stepShown(): string | null {
  return container.querySelector("[data-wizard-step]")?.getAttribute("data-wizard-step") ?? null;
}

async function click(selector: string): Promise<void> {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`nothing matches ${selector} on step ${stepShown()}`);
  await act(async () => {
    element.click();
  });
  await settle();
}

function known(onlineAt: number | null, checkedAt: number) {
  return {
    state: "known",
    onlineAt: onlineAt === null ? null : new Date(onlineAt).toISOString(),
    firstConnectedAt: null,
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  searchParams = new URLSearchParams();
  subscriptionsPayload = { subscriptions: [subscription("a", "Семейный"), subscription("b", "Premium")] };
  connectionAnswers = [known(null, BASE)];
  getSubscriptionConnection.mockClear();
  navigate.mockClear();
  Object.defineProperty(navigator, "userAgent", {
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    configurable: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("the guided connect walk", () => {
  it("asks which subscription first, opened on the card that was tapped", async () => {
    searchParams = new URLSearchParams({ subscriptionId: "b" });
    await render();

    expect(stepShown()).toBe("select");
    expect(container.querySelectorAll("[data-card]")).toHaveLength(2);
    // The home screen's order and position looks: card N wears slot N.
    expect(container.querySelector("[data-card='b']")?.getAttribute("data-card-index")).toBe("1");
    expect(container.querySelector("[data-wizard-slide='b']")?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelector("[data-wizard-pick]")?.textContent).toContain("Premium");
  });

  it("goes straight to the start with a single subscription", async () => {
    subscriptionsPayload = { subscriptions: [subscription("a", "Семейный")] };
    await render();
    expect(stepShown()).toBe("start");
    expect(container.querySelector("[data-wizard-chip]")?.textContent).toContain("Семейный");
  });

  it("offers renewal instead of connecting a single expired subscription", async () => {
    subscriptionsPayload = { subscriptions: [subscription("a", "Пробный", { status: "EXPIRED" })] };
    await render();
    expect(stepShown()).toBe("select");
    expect(container.textContent).toContain("connectWizard.renew");
    expect(container.querySelector("[data-wizard-pick]")).toBeNull();
  });

  it("walks every step and finishes by itself when the profile comes online", async () => {
    searchParams = new URLSearchParams({ subscriptionId: "b" });
    // The start screen's baseline: never online. Every later answer: online.
    connectionAnswers = [known(null, BASE), known(BASE + 30_000, BASE + 40_000)];
    await render();

    await click("[data-wizard-pick]");
    expect(stepShown()).toBe("start");

    await click("[data-wizard-begin]");
    expect(stepShown()).toBe("device");
    expect(container.querySelector("[data-wizard-device]")?.textContent).toContain("connectWizard.autoTag");

    await click("[data-wizard-device-ok]");
    expect(stepShown()).toBe("app");
    expect(container.querySelector("[data-wizard-app]")?.getAttribute("data-wizard-app")).toBe("happ");
    expect(container.querySelectorAll("[data-wizard-download]")).toHaveLength(1);

    await click("[data-wizard-installed]");
    expect(stepShown()).toBe("add");
    // The subscription the customer CHOSE, in the app's own scheme.
    expect(container.querySelector("a[data-wizard-add]")?.getAttribute("href")).toBe("happ://add/https://sub.test/b");

    await click("[data-wizard-added]");
    expect(stepShown()).toBe("enable");

    // The finish waits a moment for the radar; reduced motion shortens it.
    await settle(50);
    expect(container.querySelector("[data-wizard-status]")?.getAttribute("data-wizard-status")).toBe("connected");
    await settle(500);
    expect(stepShown()).toBe("done");
    expect(container.querySelector("[data-wizard-details]")?.textContent).toContain("connectWizard.detailCheckSignal");
    expect(getSubscriptionConnection).toHaveBeenCalledWith("b");
  });

  it("does not call a second device connected because the first one is online", async () => {
    // After «Подключить ещё устройство» the phone just connected keeps moving
    // `onlineAt`. Measured against the first round's baseline the second
    // device would be "connected" at once; a fresh baseline reads it as busy.
    subscriptionsPayload = { subscriptions: [subscription("a", "Семейный")] };
    connectionAnswers = [known(null, BASE), known(BASE + 30_000, BASE + 40_000)];
    await render();
    await click("[data-wizard-begin]");
    await click("[data-wizard-device-ok]");
    await click("[data-wizard-installed]");
    await click("[data-wizard-added]");
    await settle(500);
    expect(stepShown()).toBe("done");

    const another = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("connectWizard.another"),
    );
    await act(async () => another?.click());
    await settle();
    expect(stepShown()).toBe("device");
    await click("[data-wizard-device-ok]");
    await click("[data-wizard-installed]");
    await click("[data-wizard-added]");
    await settle(500);

    expect(stepShown()).toBe("enable");
    expect(container.querySelector("[data-wizard-status]")?.getAttribute("data-wizard-status")).toBe("busy");
    expect(container.querySelector("[data-wizard-it-works]")).not.toBeNull();
  });

  it("asks the customer instead of guessing when another device is already online", async () => {
    subscriptionsPayload = { subscriptions: [subscription("a", "Семейный")] };
    connectionAnswers = [known(BASE - 10_000, BASE)];
    await render();

    await click("[data-wizard-begin]");
    await click("[data-wizard-device-ok]");
    await click("[data-wizard-installed]");
    await click("[data-wizard-added]");
    await settle(20);

    expect(container.querySelector("[data-wizard-status]")?.getAttribute("data-wizard-status")).toBe("busy");
    await click("[data-wizard-it-works]");
    expect(stepShown()).toBe("done");
    expect(container.querySelector("[data-wizard-details]")?.textContent).toContain(
      "connectWizard.detailCheckCustomer",
    );
  });

  it("offers the copy button for an app that cannot take the link in one tap", async () => {
    subscriptionsPayload = { subscriptions: [subscription("a", "Семейный")] };
    await render();

    await click("[data-wizard-begin]");
    await click("[data-wizard-platform='android']");
    await click("[data-wizard-device-ok]");
    await click("[data-wizard-installed]");

    expect(stepShown()).toBe("add");
    expect(container.querySelector("[data-wizard-add]")).toBeNull();
    expect(container.querySelector("[data-wizard-copy]")).not.toBeNull();
  });

  it("goes back along the way it came, and leaves from the first screen", async () => {
    subscriptionsPayload = { subscriptions: [subscription("a", "Семейный")] };
    await render();
    await click("[data-wizard-begin]");
    await click("[data-wizard-device-ok]");
    expect(stepShown()).toBe("app");

    await click("button[aria-label='connectWizard.back']");
    expect(stepShown()).toBe("device");
    await click("button[aria-label='connectWizard.back']");
    expect(stepShown()).toBe("start");
    await click("button[aria-label='connectWizard.back']");
    expect(navigate).toHaveBeenCalled();
  });
});
