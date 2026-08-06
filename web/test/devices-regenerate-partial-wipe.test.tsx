// @vitest-environment jsdom

/**
 * Link regeneration reports TWO outcomes, and the customer is told about both.
 *
 * The admin panel rotates and PERSISTS the subscription link first, then wipes
 * the devices bound to the profile. That second step is deliberately non-fatal
 * there: by the time it runs the new link already works, so failing the whole
 * call would only push the customer into re-rotating a link that is fine. The
 * response therefore carries `devicesCleared`, and
 * `{ regenerated: true, devicesCleared: false }` is a SUCCESS in which half of
 * what the confirm dialog promised did not happen.
 *
 * `DevicesList` used to toast "Link regenerated. Reconnect your devices." on
 * every success. For a failed wipe that is wrong twice: nothing was
 * disconnected, and the old devices still occupy their slots, so following the
 * instruction can run straight into the device limit.
 *
 * The component under test is the REAL one, so removing the branch fails this
 * spec rather than a mock of it.
 */

import { QueryClient, QueryClientProvider, defaultScheduler, notifyManager } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deleteSubscriptionDevice: vi.fn(),
  regenerateSubscriptionLink: vi.fn(),
}));
const sonner = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

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
vi.mock("sonner", () => sonner);
vi.mock("@/lib/api-client", () => api);
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
}));

import { DevicesList } from "../src/features/dashboard/components/devices-list";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(ticks = 4): Promise<void> {
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
        <DevicesList
          devices={[]}
          isLoading={false}
          subscriptionId="sub_1"
          subscriptionUrl="https://example.test/sub"
          deviceLimit={3}
          trafficLimit={100}
        />
      </QueryClientProvider>,
    );
  });
}

function buttonsLabelled(label: string): HTMLButtonElement[] {
  return [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].filter(
    (candidate) => candidate.textContent?.includes(label),
  );
}

/**
 * Opens the confirm dialog and presses its confirm button.
 *
 * The header trigger and the dialog's confirm both read `devices.regenerate`;
 * only the header one carries an aria-label, which is what tells them apart.
 */
async function confirmRegenerate(): Promise<void> {
  const trigger = buttonsLabelled("devices.regenerate").find((candidate) =>
    candidate.hasAttribute("aria-label"),
  );
  expect(trigger, "header regenerate trigger").toBeTruthy();
  act(() => trigger?.click());
  await settle(1);

  const confirm = buttonsLabelled("devices.regenerate").find(
    (candidate) => !candidate.hasAttribute("aria-label"),
  );
  expect(confirm, "dialog confirm button").toBeTruthy();
  act(() => confirm?.click());
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // See `dashboard-devices-load-failure.test.tsx`: the default scheduler defers
  // observer notifications onto a real timer that can land outside the open act
  // scope under full-suite load. Microtasks drain ahead of timers.
  notifyManager.setScheduler(queueMicrotask);
  api.regenerateSubscriptionLink.mockReset();
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

describe("DevicesList link regeneration", () => {
  it("does NOT claim devices were disconnected when the wipe failed", async () => {
    api.regenerateSubscriptionLink.mockResolvedValue({
      regenerated: true,
      url: "https://example.test/new",
      devicesCleared: false,
    });
    render();
    await confirmRegenerate();

    // Self-check: the call really happened and really resolved.
    expect(api.regenerateSubscriptionLink).toHaveBeenCalledWith("sub_1");
    expect(sonner.toast.warning).toHaveBeenCalledWith(
      "devices.regeneratedNotCleared",
      expect.anything(),
    );
    // The whole point: the "reconnect your devices" line must not be shown for
    // devices that were never disconnected.
    expect(sonner.toast.success).not.toHaveBeenCalled();
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it("reports a clean regeneration unchanged", async () => {
    api.regenerateSubscriptionLink.mockResolvedValue({
      regenerated: true,
      url: "https://example.test/new",
      devicesCleared: true,
    });
    render();
    await confirmRegenerate();

    expect(sonner.toast.success).toHaveBeenCalledWith("devices.regenerated");
    expect(sonner.toast.warning).not.toHaveBeenCalled();
  });

  it("treats an absent devicesCleared as no reported failure", async () => {
    // The BFF answers `{ regenerated: true }` when the admin client is not
    // configured. Absent is not a reported failure, so it stays on the success
    // path — only an explicit `false` may warn.
    api.regenerateSubscriptionLink.mockResolvedValue({ regenerated: true });
    render();
    await confirmRegenerate();

    expect(sonner.toast.success).toHaveBeenCalledWith("devices.regenerated");
    expect(sonner.toast.warning).not.toHaveBeenCalled();
  });

  it("still surfaces a genuine failure as an error", async () => {
    api.regenerateSubscriptionLink.mockRejectedValue(new Error("502"));
    render();
    await confirmRegenerate();

    expect(sonner.toast.error).toHaveBeenCalledWith("devices.error");
    expect(sonner.toast.success).not.toHaveBeenCalled();
    expect(sonner.toast.warning).not.toHaveBeenCalled();
  });

  it("carries the partial-wipe copy in BOTH locales, and it is not the clean one", () => {
    // `en` is typed `RuDict`, so a missing English key is a compile error — but
    // nothing stops the two strings from being copy-pasted equal, which would
    // silently reinstate the lie in one language.
    for (const [name, dict] of [
      ["en", en],
      ["ru", ru],
    ] as const) {
      expect(dict.devices.regeneratedNotCleared, `${name} copy`).toBeTruthy();
      expect(dict.devices.regeneratedNotCleared).not.toBe(dict.devices.regenerated);
    }
  });
});
