// @vitest-environment jsdom

/**
 * Both ways into the points history, and the one sentence that must not
 * over-promise.
 * ══════════════════════════════════════════════════════════════════════════
 * The dialog is reachable from two screens — the referrals page's points
 * row and the exchange page's "История" card — and it used to exist only
 * as JSX inlined in the first of them. A second copy would drift, so it is
 * one component now; these cases pin that BOTH entry points still open it
 * and that the ledger is inside when they do.
 *
 * The description is the part with a way to become false. An install that
 * pays points only for invited friends must not read "начисляются за
 * покупки": the panel reports `cashbackEnabled`, an older one omits it,
 * and `undefined` has to fall to the narrower sentence rather than the
 * broader one. The two keys share a prefix, so the assertions are on the
 * description node's exact text — `toContain("referrals.pointsHint")`
 * would pass for both and prove nothing.
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
  getReferralSummary: vi.fn(),
  getInviteCapacity: vi.fn(),
  getInvitedUsers: vi.fn(),
  getPointsLedger: vi.fn(),
  getPointsExchangeOptions: vi.fn(),
  getAllSubscriptions: vi.fn(),
  exchangePoints: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const sonner = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("sonner", () => sonner);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: "ru" },
  }),
}));
vi.mock("motion/react", () => {
  const MOTION_ONLY = new Set([
    "initial",
    "animate",
    "exit",
    "transition",
    "whileTap",
    "whileHover",
    "whileInView",
    "layout",
    "layoutId",
    "variants",
    "drag",
  ]);
  const strip = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).filter(([key]) => !MOTION_ONLY.has(key)));
  return {
    motion: {
      div: (props: Record<string, unknown>) => <div {...(strip(props) as ComponentProps<"div">)} />,
      span: (props: Record<string, unknown>) => (
        <span {...(strip(props) as ComponentProps<"span">)} />
      ),
      button: (props: Record<string, unknown>) => (
        <button {...(strip(props) as ComponentProps<"button">)} />
      ),
    },
    AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});
// The real Dialog is a Radix portal + focus trap; the spec is about what is
// inside it, so this keeps the open/closed decision and drops the rest. The
// description gets a testid because the two hint keys share a prefix.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { readonly children: ReactNode }) => (
    <p data-testid="dialog-description">{children}</p>
  ),
}));
vi.mock("@/components/ui/stadium-button", () => ({
  StadiumButton: ({
    children,
    onClick,
  }: {
    readonly children: ReactNode;
    readonly onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button">back</button>,
}));
vi.mock("@/components/ui/tip-card", () => ({
  TipCard: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/use-safe-back", () => ({ useSafeBack: () => vi.fn() }));
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({
    session: { id: "u1", telegramId: null, userId: 1, name: "A", role: "USER" },
    isLoading: false,
    isAuthenticated: true,
    error: null,
  }),
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Rezeis" }, botUsername: "rezeis_bot" }),
}));
// Pulls in `qrcode` and the clipboard/share paths — none of it is this spec.
vi.mock("../src/features/referrals/components/invite-link-hero", () => ({
  InviteLinkHero: () => <div>hero</div>,
}));

import ReferralsPage from "../src/features/referrals/referrals-page";
import PointsExchangePage from "../src/features/referrals/points-exchange-page";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const SUMMARY = {
  totalReferrals: 4,
  qualifiedReferrals: 2,
  pointsBalance: 320,
  programAvailable: true,
  referralCode: "u1",
};

const LEDGER_PAGE = {
  items: [
    {
      id: "e1",
      delta: 50,
      balanceAfter: 320,
      source: "REFERRAL_REWARD",
      referenceKey: null,
      details: null,
      createdAt: "2026-08-20T12:00:00.000Z",
    },
  ],
  nextCursor: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(): string {
  return container?.textContent ?? "";
}

function buttonSaying(fragment: string): HTMLButtonElement | null {
  const buttons = Array.from(container?.querySelectorAll("button") ?? []);
  return buttons.find((button) => (button.textContent ?? "").includes(fragment)) ?? null;
}

function description(): string | null {
  return container?.querySelector('[data-testid="dialog-description"]')?.textContent ?? null;
}

async function render(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });
  act(() => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  await settle();
}

beforeEach(() => {
  notifyManager.setScheduler(queueMicrotask);
  for (const fn of Object.values(api)) fn.mockReset();
  navigate.mockReset();
  api.getReferralSummary.mockResolvedValue(SUMMARY);
  api.getInviteCapacity.mockResolvedValue({
    totalSlots: null,
    usedSlots: 0,
    remainingSlots: null,
    canCreateInvite: true,
  });
  api.getInvitedUsers.mockResolvedValue({ items: [], total: 0, page: 1, limit: 6 });
  api.getPointsLedger.mockResolvedValue(LEDGER_PAGE);
  api.getPointsExchangeOptions.mockResolvedValue({
    exchangeEnabled: true,
    pointsBalance: 320,
    types: [
      {
        type: "SUBSCRIPTION_DAYS",
        enabled: true,
        available: true,
        pointsCost: 10,
        minPoints: 10,
        maxPoints: 1000,
        computedValue: 1,
      },
    ],
  });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  notifyManager.setScheduler(defaultScheduler);
});

async function openPointsRow(): Promise<void> {
  const row = buttonSaying("referrals.points");
  expect(row).not.toBeNull();
  await act(async () => {
    row?.click();
  });
  await settle();
}

describe("referrals page points dialog", () => {
  it("opens on the points row and brings the ledger with it", async () => {
    await render(<ReferralsPage />);
    // Closed to begin with — otherwise "it is open after the tap" is vacuous.
    expect(text()).not.toContain("pointsHistory.title");

    await openPointsRow();

    expect(text()).toContain("pointsHistory.title");
    expect(text()).toContain("pointsHistory.sources.REFERRAL_REWARD");
    expect(text()).toContain("320");
    // The referrals page is the one place the exchange button belongs.
    expect(buttonSaying("referrals.exchangePoints")).not.toBeNull();
  });

  it("promises purchase cashback only when the panel says it pays it", async () => {
    api.getReferralSummary.mockResolvedValue({ ...SUMMARY, cashbackEnabled: true });
    await render(<ReferralsPage />);
    await openPointsRow();

    expect(description()).toBe("referrals.pointsHintCashback");
  });

  it("keeps the narrower promise when the flag is false", async () => {
    api.getReferralSummary.mockResolvedValue({ ...SUMMARY, cashbackEnabled: false });
    await render(<ReferralsPage />);
    await openPointsRow();

    expect(description()).toBe("referrals.pointsHint");
  });

  it("keeps the narrower promise against a panel too old to have the flag", async () => {
    // No `cashbackEnabled` key at all. `undefined` must not read as `true`.
    await render(<ReferralsPage />);
    await openPointsRow();

    expect(description()).toBe("referrals.pointsHint");
  });
});

describe("points exchange page history card", () => {
  it("opens the same dialog, without the button that leads back here", async () => {
    await render(<PointsExchangePage />);
    expect(text()).not.toContain("pointsHistory.title");

    const card = buttonSaying("pointsExchange.history");
    expect(card).not.toBeNull();
    await act(async () => {
      card?.click();
    });
    await settle();

    expect(text()).toContain("pointsHistory.title");
    expect(text()).toContain("pointsHistory.sources.REFERRAL_REWARD");
    // Navigating to the exchange from inside the exchange is a no-op the
    // customer reads as a broken button.
    expect(buttonSaying("referrals.exchangePoints")).toBeNull();
  });
});
