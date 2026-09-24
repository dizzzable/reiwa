// @vitest-environment jsdom

/**
 * A paid add-on's notices on «Настройка уведомлений».
 *
 * The panel tells a customer three days before a paid add-on — extra traffic
 * or devices — ends, and when it has; each goes by the bot, push and a letter,
 * so the customer may silence each, and the panel lists `addon_ends_in_3_days`
 * and `addon_ended` among the types they may. The switches are drawn only when
 * it does: an older panel sends no such notice.
 *
 * ONE switch per moment: the panel files a device add-on's notices — their own
 * words for what the end does to the devices — under the same two keys.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/i18n/en";
import { ru } from "@/i18n/ru";

const api = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(async () => ({ publicKey: "" })),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => ({
  detectPushSupport: () => "unsupported-browser",
  getCurrentSubscription: async () => null,
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}));
vi.mock("@/lib/telegram-launch-params", () => ({ isTelegramMiniAppSurface: () => false }));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    onCheckedChange?: (next: boolean) => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked ? "true" : "false"}
      aria-label={String(rest["aria-label"] ?? "")}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
}));
vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
}));
vi.mock("@/components/ui/separator", () => ({ Separator: () => <hr /> }));

import NotificationsSettingsPage from "../src/features/settings/notifications-settings-page";

const EXPIRY = ["expires_in_3_days", "expired"];
const ADD_ONS = ["addon_ends_in_3_days", "addon_ended"];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.updateNotificationPreferences.mockImplementation(async (patch: Record<string, boolean>) => ({
    prefs: patch,
    available: [...EXPIRY, ...ADD_ONS],
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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
    if (switches().length > 0) break;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function switches(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='switch']")];
}

const switchFor = (label: string) => switches().find((node) => node.getAttribute("aria-label") === label);

describe("the add-on switches", () => {
  it("are drawn, in their own group, when the panel honours them — on until switched off", async () => {
    api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: [...EXPIRY, ...ADD_ONS] });
    await render();

    expect(switches()).toHaveLength(EXPIRY.length + ADD_ONS.length);
    expect(container.textContent).toContain("notifications.addonsGroup");
    expect(switchFor("notifications.addonEndsSoon")?.getAttribute("aria-checked")).toBe("true");
    expect(switchFor("notifications.addonEnded")?.getAttribute("aria-checked")).toBe("true");
  });

  it("are not drawn by a panel that sends no such notice", async () => {
    api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: EXPIRY });
    await render();

    expect(switches()).toHaveLength(EXPIRY.length);
    expect(container.textContent).not.toContain("notifications.addonsGroup");
  });

  it("save exactly their own key, and show a stored opt-out as off", async () => {
    api.getNotificationPreferences.mockResolvedValue({
      prefs: { addon_ended: false },
      available: [...EXPIRY, ...ADD_ONS],
    });
    await render();

    expect(switchFor("notifications.addonEnded")?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      switchFor("notifications.addonEndsSoon")?.click();
    });
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({ addon_ends_in_3_days: false });
  });

  it("have words in both languages", () => {
    for (const dictionary of [ru, en]) {
      expect(dictionary.notifications.addonsGroup.length).toBeGreaterThan(0);
      expect(dictionary.notifications.addonEndsSoon.length).toBeGreaterThan(0);
      expect(dictionary.notifications.addonEnded.length).toBeGreaterThan(0);
    }
  });
});
