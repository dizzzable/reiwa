// @vitest-environment jsdom

import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("motion/react", () => ({
  motion: {
    span: ({ children, ...props }: ComponentProps<"span">) => (
      <span {...props}>{children}</span>
    ),
  },
}));
vi.mock("sonner", () => ({ toast }));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/components/layout/use-nav-tabs", () => ({
  useSupportInNav: () => false,
}));
vi.mock("@/hooks/use-support-unread", () => ({
  useSupportUnread: () => 0,
}));
vi.mock("@/components/ui/emoji-text", () => ({
  EmojiText: ({ text }: { readonly text: string }) => <>{text}</>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
}));

import { NotificationBell } from "../src/features/dashboard/components/notification-bell";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let upstreamUnreadCount = 1;
let upstreamReadAt: string | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return buttonByText(text);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await settle();
    }
  }

  throw lastError ?? new Error(`Button not found: ${text}`);
}

function notificationBellButton(): HTMLButtonElement {
  const button = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("notifications.feedTitle"),
    );
  if (!button) throw new Error("Notification bell was not rendered");
  return button;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React Query defers every observer notification onto a real
  // `setTimeout(…, 0)`, registered while the settled query/mutation promise
  // drains its microtasks — i.e. AFTER the timer `settle()` has already
  // registered for its own wakeup. Both are 0 ms, so they share a timer phase
  // only while that drain stays inside one millisecond. Under full-suite load
  // it does not, and the act scope wakes before the invalidated feed re-render
  // lands — which is exactly what these assertions read (the mark-all button
  // disappearing, and the optimistic state being rolled back on failure).
  // Microtasks always drain ahead of timers, so scheduling notifications on
  // them puts the re-render inside the open act scope regardless of the wall
  // clock. Same fix, same reason, as `privacy-page-deep-link.test.tsx`.
  notifyManager.setScheduler(queueMicrotask);
  upstreamUnreadCount = 1;
  upstreamReadAt = null;
  api.getUnreadCount.mockImplementation(async () => ({ count: upstreamUnreadCount }));
  api.getNotifications.mockImplementation(async () =>
    ({
      notifications: [
        {
          id: "expiry-1",
          type: "subscription_expiring",
          payload: { plan: "Standard", days: 1 },
          readAt: upstreamReadAt,
          createdAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    }));
  api.markAllNotificationsRead.mockImplementation(async () => {
    upstreamUnreadCount = 0;
    upstreamReadAt = "2026-08-01T10:01:00.000Z";
    return { ok: true };
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
});

describe("NotificationBell", () => {
  it("marks every notification read from the recent-news dialog and clears the unread affordance", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <NotificationBell />
        </QueryClientProvider>,
      );
    });
    await settle();

    act(() => notificationBellButton().click());
    expect(await waitForButtonByText("activity.markAllRead")).toBeTruthy();

    act(() => buttonByText("activity.markAllRead").click());
    await settle();

    expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .some((button) => button.textContent?.includes("activity.markAllRead")),
    ).toBe(false);
  });

  it("restores the unread state and reports an error when mark-all fails", async () => {
    api.markAllNotificationsRead.mockRejectedValueOnce(new Error("Upstream unavailable"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <NotificationBell />
        </QueryClientProvider>,
      );
    });
    await settle();
    act(() => notificationBellButton().click());
    const markAllButton = await waitForButtonByText("activity.markAllRead");
    act(() => markAllButton.click());
    await settle();

    expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(buttonByText("activity.markAllRead")).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("notifications.markAllReadFailed");
  });
});
