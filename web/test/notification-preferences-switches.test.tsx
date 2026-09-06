// @vitest-environment jsdom

/**
 * The switches on «Уведомления».
 *
 * They were seven `<Switch defaultChecked>` with no handler: they moved when
 * you touched them, stayed until the page unmounted, and changed nothing at
 * all — no route accepted a preference and no column stored one. Two of the
 * seven governed reminders no emitter has ever produced.
 *
 * What matters most here is not that a click saves. It is that a switch is
 * only ever DRAWN when the panel says it honours that type: the panel ships
 * ahead of this image, so a cabinet that renders its own idea of the list
 * would put a dead control back on the screen in a newer coat.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(async () => ({ publicKey: null })),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => ({
  detectPushSupport: async () => ({ supported: false, reason: "unsupported" }),
  getCurrentSubscription: async () => null,
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}));
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

const ALL_FIVE = [
  "expires_in_3_days",
  "expires_in_2_days",
  "expires_in_1_days",
  "expired",
  "expired_1_day_ago",
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: ALL_FIVE });
  api.updateNotificationPreferences.mockImplementation(async (patch: Record<string, boolean>) => ({
    prefs: patch,
    available: ALL_FIVE,
  }));
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
    if (switches().length > 0) break;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function switches(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='switch']")];
}

function switchFor(labelKey: string): HTMLButtonElement | undefined {
  return switches().find((node) => node.getAttribute("aria-label") === labelKey);
}

describe("the expiry notification switches", () => {
  it("draws one switch per type the panel says it honours", async () => {
    await render();
    expect(switches()).toHaveLength(5);
  });

  it("draws none at all when the panel honours nothing", async () => {
    // An older panel, or an unreachable one. A switch nobody acts on is the
    // exact defect this screen had; drawing nothing is the honest answer.
    api.getNotificationPreferences.mockResolvedValue({ prefs: {}, available: [] });
    await render();
    expect(switches()).toHaveLength(0);
  });

  it("draws only the subset a partial panel honours", async () => {
    api.getNotificationPreferences.mockResolvedValue({
      prefs: {},
      available: ["expired", "expires_in_1_days"],
    });
    await render();
    expect(switches()).toHaveLength(2);
  });

  it("shows a stored switch as off and the rest as on", async () => {
    // Absent means send — the same direction the server reads it in.
    api.getNotificationPreferences.mockResolvedValue({
      prefs: { expired: false },
      available: ALL_FIVE,
    });
    await render();
    expect(switchFor("notifications.dayOf")?.getAttribute("aria-checked")).toBe("false");
    expect(switchFor("notifications.days3")?.getAttribute("aria-checked")).toBe("true");
  });

  it("saves the one switch that moved, not the whole map", async () => {
    // The server merges, so sending everything would be harmless — but
    // sending one is what makes a concurrent change on another device
    // survive.
    await render();
    await act(async () => {
      switchFor("notifications.days3")?.click();
    });
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({ expires_in_3_days: false });
  });

  it("turns a switch back on", async () => {
    api.getNotificationPreferences.mockResolvedValue({
      prefs: { expired: false },
      available: ALL_FIVE,
    });
    await render();
    await act(async () => {
      switchFor("notifications.dayOf")?.click();
    });
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({ expired: true });
  });

  it("says so when the save failed instead of leaving the switch moved", async () => {
    api.updateNotificationPreferences.mockRejectedValue(new Error("nope"));
    await render();
    await act(async () => {
      switchFor("notifications.days3")?.click();
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(toast.error).toHaveBeenCalled();
  });

  it("offers no switch for a reminder nobody sends", async () => {
    // «через 2 дня» / «через 3 дня» after expiry had switches and no emitter.
    await render();
    expect(switchFor("notifications.after2")).toBeUndefined();
    expect(switchFor("notifications.after3")).toBeUndefined();
  });
});
