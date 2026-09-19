// @vitest-environment jsdom

/**
 * «Помощь с подключением» on «Настройка уведомлений».
 *
 * The panel sends one message per subscription that was bought and never
 * connected, and lists `connect_help` among the types a subscriber may silence.
 * The switch is drawn only when it does — the panel ships separately, and a
 * switch it does not honour would be the dead control this screen used to be.
 *
 * ONE switch covers both notices: the panel files the trial-and-gift notice
 * (`connect_help_trial`) under the same key, so a second row could switch
 * nothing the first does not.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  // An empty key: the browser-push card steps aside and the page is only the
  // switches, which is what this file is about.
  getPushPublicKey: vi.fn(async () => ({ publicKey: "" })),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api-client", () => api);
// The real function answers synchronously with a string; so does this one.
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

const EXPIRY = ["expires_in_3_days", "expires_in_1_days", "expired"];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.updateNotificationPreferences.mockImplementation(async (patch: Record<string, boolean>) => ({
    prefs: patch,
    available: [...EXPIRY, "connect_help"],
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

function helpSwitch(): HTMLButtonElement | undefined {
  return switches().find((node) => node.getAttribute("aria-label") === "connectHelp.settingsSwitch");
}

describe("the «Помощь с подключением» switch", () => {
  it("is drawn when the panel honours connect_help", async () => {
    api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: [...EXPIRY, "connect_help"] });
    await render();

    expect(helpSwitch(), "no «Помощь с подключением» switch").toBeDefined();
    expect(container.textContent).toContain("connectHelp.settingsGroup");
    expect(container.textContent).toContain("connectHelp.settingsHint");
    // Absent means "send it" — the direction the server reads it in.
    expect(helpSwitch()?.getAttribute("aria-checked")).toBe("true");
  });

  it("is not drawn by a panel that does not honour it", async () => {
    api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: EXPIRY });
    await render();

    // Anti-vacuity: the page DID render its switches, just not this one.
    expect(switches()).toHaveLength(EXPIRY.length);
    expect(helpSwitch()).toBeUndefined();
    expect(container.textContent).not.toContain("connectHelp.settingsGroup");
  });

  it("is ONE switch — the trial twin is filed under the same key", async () => {
    api.getNotificationPreferences.mockResolvedValue({
      prefs: {},
      available: [...EXPIRY, "connect_help", "connect_help_trial"],
    });
    await render();

    expect(switches()).toHaveLength(EXPIRY.length + 1);
  });

  it("saves exactly its own key when switched off", async () => {
    api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: [...EXPIRY, "connect_help"] });
    await render();

    await act(async () => {
      helpSwitch()?.click();
    });

    expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({ connect_help: false });
  });

  it("shows a stored opt-out as off, and turns it back on", async () => {
    api.getNotificationPreferences.mockResolvedValue({
      prefs: { connect_help: false },
      available: [...EXPIRY, "connect_help"],
    });
    await render();

    expect(helpSwitch()?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      helpSwitch()?.click();
    });
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({ connect_help: true });
  });
});
