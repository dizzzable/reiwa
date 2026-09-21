// @vitest-environment jsdom

/**
 * WHAT THE PUSH SWITCH ON «Уведомления» IS ALLOWED TO MEAN.
 *
 * It used to mean "this browser holds a `PushSubscription` object", which is
 * not the same fact as "the panel can reach this browser" and is the one that
 * cannot be acted on. The two come apart constantly:
 *
 *   • a second device, or the app reinstalled — the browser re-mints a
 *     subscription on its own and the panel never hears about it;
 *   • a second account signed in behind the first — the row is registered to
 *     whoever was here before;
 *   • the panel's 410 sweep pruned the endpoint.
 *
 * In every one of those the customer opened «Уведомления», read «включены»,
 * received nothing, and had nothing left to switch on — switching it ON was
 * not available, and switching it OFF and back ON is not something anybody
 * thinks to try. Reported from production 2026-09-21: "переходишь с
 * устройства на устройство — пуш не включится".
 *
 * So the mount re-registers the endpoint against the account signed in NOW
 * (idempotent, never prompts) and the switch shows whether THAT landed.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(async () => ({ publicKey: "BPublicKey" })),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));
const push = vi.hoisted(() => ({
  detectPushSupport: vi.fn(() => "supported"),
  ensurePushSubscription: vi.fn(async () => true),
  getCurrentSubscription: vi.fn(async () => ({ endpoint: "https://push/one" }) as unknown),
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => push);
vi.mock("@/lib/telegram-launch-params", () => ({ isTelegramMiniAppSurface: () => false }));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (next: boolean) => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked ? "true" : "false"}
      aria-label={String(rest["aria-label"] ?? "")}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
}));
vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
}));
vi.mock("@/components/ui/separator", () => ({ Separator: () => <hr /> }));

import NotificationsSettingsPage from "../src/features/settings/notifications-settings-page";

/** The push switch, told apart from the per-type ones by its own label key. */
const PUSH_SWITCH_LABEL = "notifications.pushToggleEnable";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <NotificationsSettingsPage />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (pushSwitch() !== undefined) break;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function pushSwitch(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='switch']")].find(
    (node) => node.getAttribute("aria-label") === PUSH_SWITCH_LABEL,
  );
}

describe("the browser-push switch", () => {
  it("re-registers this browser's endpoint against the account signed in now", async () => {
    await render();

    expect(
      push.ensurePushSubscription,
      "the switch reported the browser's own state and never asked the server, so a row bound to somebody else looked like success",
    ).toHaveBeenCalledTimes(1);
    expect(pushSwitch()?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows OFF — and therefore usable — when the re-registration did not land", async () => {
    // THE DEFECT. The browser holds a subscription, so the old reading said
    // «включены»; the panel does not have it, so nothing arrives. OFF is the
    // honest answer AND the actionable one: one tap re-subscribes.
    push.ensurePushSubscription.mockResolvedValue(false);

    await render();

    const control = pushSwitch();
    expect(control?.getAttribute("aria-checked")).toBe("false");
    expect(
      control?.disabled,
      "a switch that reads OFF and cannot be pressed leaves the customer exactly where the bug left them",
    ).toBe(false);
  });

  it("does not ask the server about a browser that holds no subscription", async () => {
    // ANTI-VACUITY: "always call it" would prompt nothing but would spend a
    // request per visit for every customer who never opted in — and would
    // report ON for a browser that has nothing, since the heal re-subscribes.
    push.getCurrentSubscription.mockResolvedValue(null);

    await render();

    expect(push.ensurePushSubscription).not.toHaveBeenCalled();
    expect(pushSwitch()?.getAttribute("aria-checked")).toBe("false");
  });
});
