// @vitest-environment jsdom
/**
 * «Можно подключить ещё N устройств» (the owner, 30.10.2026): under the
 * devices of the selected subscription, while a slot is free, a quiet row that
 * shows THIS subscription's link as a QR code — so a second device adds it
 * from its VPN app's scanner.
 *
 * Held here: when the row is offered and when it is not, what it says, and
 * that the code it opens is the selected subscription's own link.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, initial: _i, animate: _a, transition: _t, ...props }: ComponentProps<"div"> & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    ),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/api-client", () => ({ deleteSubscriptionDevice: vi.fn(), regenerateSubscriptionLink: vi.fn() }));
vi.mock("@/lib/operator-time-zone", () => ({ useOperatorTimeZone: () => "UTC" }));

import { DevicesList } from "../src/features/dashboard/components/devices-list";
import type { HwidDevice } from "../src/types/api";

const URL = "https://sub.example.com/abc123";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

function device(hwid: string): HwidDevice {
  return { hwid, platform: "iOS", deviceModel: `iPhone ${hwid}`, lastSeenAt: null } as unknown as HwidDevice;
}

function show(props: Partial<ComponentProps<typeof DevicesList>>): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <DevicesList
          devices={[device("1"), device("2")]}
          isLoading={false}
          subscriptionId="sub-1"
          subscriptionUrl={URL}
          deviceLimit={3}
          canAddDevice
          subscriptionName="Стандарт"
          {...props}
        />
      </QueryClientProvider>,
    );
  });
}

const row = (): HTMLButtonElement | null => document.querySelector('[data-testid="devices-add-more"]');

describe("the free-slot row", () => {
  it("counts the slots left on the selected subscription", () => {
    show({});
    expect(row()?.textContent).toContain("devices.addMore:1");
  });

  it("is not offered when every slot is taken", () => {
    show({ devices: [device("1"), device("2"), device("3")] });
    expect(row()).toBeNull();
  });

  it("is not offered for a subscription that does not run", () => {
    show({ canAddDevice: false });
    expect(row()).toBeNull();
  });

  it("is not offered without a link, nor over a device list that failed to load", () => {
    show({ subscriptionUrl: null });
    expect(row()).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    show({ isError: true, devices: [] });
    expect(row(), "a failed read has no rows, and «ещё 3» would be a guess").toBeNull();
  });

  it("speaks of the first device when none is connected yet", () => {
    show({ devices: [] });
    expect(row()?.textContent).toContain("devices.addFirst:3");
  });

  it("has no count on a subscription without a device limit", () => {
    show({ deviceLimit: 0 });
    expect(row()?.textContent).toContain("devices.addUnlimited");
  });
});

describe("the code it opens", () => {
  it("is the selected subscription's own link, named, with the slots left", async () => {
    show({});
    await act(async () => {
      row()?.click();
    });
    for (let i = 0; i < 20 && document.querySelector('img[alt="devices.addTitle"]') === null; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    const code = document.querySelector<HTMLImageElement>('img[alt="devices.addTitle"]');
    expect(code, "the QR code is drawn").not.toBeNull();
    expect(code?.src.startsWith("data:image/svg+xml")).toBe(true);
    expect(document.body.textContent).toContain("Стандарт · devices.addSlots:1");
    expect(document.body.textContent).toContain("devices.addCopy");
  });
});
