// @vitest-environment jsdom

/**
 * A tap on a row of «Лента уведомлений», through the real feed page.
 *
 * «Не получилось подключиться?» names its subscription in the row's payload,
 * and the page used to decide where a tap goes from the TYPE alone — so the
 * deep link opened with no card named and the dashboard picked one itself.
 * The page now passes the payload along; every other row must go exactly where
 * it went before, including the ones whose payloads name a subscription too.
 */
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
  markAllNotificationsRead: vi.fn(async () => ({ ok: true })),
  markNotificationRead: vi.fn(async () => ({ ok: true })),
}));
const navigate = vi.hoisted(() => vi.fn());
const searchParams = vi.hoisted(() => ({ value: new URLSearchParams(""), set: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams.value, searchParams.set],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("motion/react", () => ({
  motion: {
    button: ({
      children,
      initial: _initial,
      animate: _animate,
      transition: _transition,
      ...props
    }: ComponentProps<"button"> & { initial?: unknown; animate?: unknown; transition?: unknown }) => (
      <button {...props}>{children}</button>
    ),
  },
}));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/ui/emoji-text", () => ({ EmojiText: ({ text }: { readonly text: string }) => <>{text}</> }));
vi.mock("@/components/ui/stadium-button", () => ({
  StadiumButton: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../src/features/settings/components/notification-modal", () => ({
  NotificationModal: ({ open, notification }: { readonly open: boolean; readonly notification: { id: string } | null }) =>
    open ? <div data-testid="modal">{notification?.id ?? ""}</div> : null,
}));

import NotificationsFeedPage from "../src/features/settings/notifications-feed-page";
import { resolveNotificationTarget } from "../src/lib/notification-target";

const SUBSCRIPTION = "cmsub0001abcdefghijklmno";

/** One row per family, each with the payload it really carries. */
const ROWS = [
  { id: "n-help", type: "connect_help", payload: { subscriptionId: SUBSCRIPTION, title: "Не получилось подключиться?", text: "…" } },
  { id: "n-help-trial", type: "connect_help_trial", payload: { subscriptionId: SUBSCRIPTION, title: "Не получилось подключиться?" } },
  { id: "n-help-bare", type: "connect_help", payload: null },
  { id: "n-expiry", type: "expires_in_3_days", payload: { subscriptionId: SUBSCRIPTION, daysLeft: 3, planName: "Стандарт" } },
  { id: "n-expired", type: "expired", payload: { subscriptionId: SUBSCRIPTION } },
  { id: "n-support", type: "support_reply", payload: { ticketId: "t1", subject: "Не работает", subscriptionId: SUBSCRIPTION } },
  { id: "n-referral", type: "referral.reward_issued", payload: { subscriptionId: SUBSCRIPTION } },
  { id: "n-broadcast", type: "broadcast", payload: { title: "Новость", text: "Текст", subscriptionId: SUBSCRIPTION } },
  { id: "n-admin", type: "ADMIN_MESSAGE", payload: { title: "Сообщение", text: "Текст" } },
].map((row, index) => ({ ...row, readAt: null, createdAt: `2026-09-1${index}T10:00:00.000Z` }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <NotificationsFeedPage />
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The row buttons, in the order the feed drew them. */
function rowButtons(): HTMLButtonElement[] {
  return [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
}

/** Taps a row, then lets the "mark read" it sends come back inside act. */
async function tap(id: string): Promise<void> {
  const index = ROWS.findIndex((row) => row.id === id);
  const button = rowButtons()[index];
  if (button === undefined) throw new Error(`no row drawn for ${id}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(4);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  api.getNotifications.mockResolvedValue({ notifications: ROWS });
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

describe("tapping «Не получилось подключиться?» in the feed", () => {
  it("opens the card the notice named", async () => {
    await render();
    expect(rowButtons(), "the feed drew no rows").toHaveLength(ROWS.length);

    await tap("n-help");

    expect(navigate.mock.calls).toEqual([[`/dashboard?connect=help&subscriptionId=${SUBSCRIPTION}`]]);
  });

  it("does the same for the trial twin", async () => {
    await render();

    await tap("n-help-trial");

    expect(navigate.mock.calls).toEqual([[`/dashboard?connect=help&subscriptionId=${SUBSCRIPTION}`]]);
  });

  it("still opens the deep link when the notice names no card", async () => {
    await render();

    await tap("n-help-bare");

    expect(navigate.mock.calls).toEqual([["/dashboard?connect=help"]]);
  });
});

describe("every other row goes where its type alone sent it before", () => {
  const OTHERS = ROWS.filter((row) => !row.type.startsWith("connect_help"));

  for (const row of OTHERS) {
    it(`${row.type}`, async () => {
      await render();

      await tap(row.id);

      // Before the payload was passed, the page called this with the type alone.
      const before = resolveNotificationTarget(row.type);
      if (before.kind === "route") {
        expect(navigate.mock.calls).toEqual([[before.path]]);
        expect(container?.querySelector("[data-testid='modal']")).toBeNull();
      } else {
        expect(navigate).not.toHaveBeenCalled();
        expect(container?.querySelector("[data-testid='modal']")?.textContent).toBe(row.id);
      }
    });
  }

  it("covers both kinds of destination, so neither branch above is vacuous", () => {
    const kinds = new Set(OTHERS.map((row) => resolveNotificationTarget(row.type).kind));
    expect([...kinds].sort()).toEqual(["modal", "route"]);
  });
});
