// @vitest-environment jsdom

/**
 * PartnerPage — the referral points a partner still owns, and the way out to
 * spend them.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * A subscriber earns referral points (`User.points`). When the owner appoints
 * them a partner, the panel stops creating referral rewards for them — the
 * partner engine pays them instead — but their already-earned points are
 * untouched and still spendable: no redemption path checks partner status.
 *
 * The cabinet's bottom nav has ONE slot for both programs, and an active
 * partner gets the Partner tab in it. So the points existed, were spendable,
 * and were reachable only by a bookmarked URL. This row is the fix, and the
 * button on it is the point of the whole change.
 *
 * ── The owner's rule ────────────────────────────────────────────────────────
 *
 * Show the points only while they are above zero. At zero — or when the panel
 * sends no such field — show nothing: a partner earns no new points, so a
 * permanent zero is a counter that can never move again.
 *
 * Half of that rule is an ABSENCE, so it is asserted as one. Every absence
 * test below also asserts the rest of the page is on screen, because
 * `not.toContain` passes just as happily when nothing rendered at all.
 *
 * ── Two pots, never merged ──────────────────────────────────────────────────
 *
 * `balance` is minor units of currency and is rendered as `balance / 100` with
 * a symbol. Points are a DIMENSIONLESS integer from a different pool. No
 * conversion between them exists or can exist, so the last test pins that the
 * points row carries the bare integer: no division, no currency symbol, and
 * not a digit of the money in it.
 */

import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPartnerInfo: vi.fn(),
  getPartnerEarnings: vi.fn(),
  getPartnerWithdrawals: vi.fn(),
}));

const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Echo the key (plus interpolation) so the assertions below never depend
    // on the Russian copy, only on which string the page decided to render.
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: ComponentProps<"button">) => (
      <button {...props}>{children}</button>
    ),
  },
}));

vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({ session: { id: "reiwa-id-1" }, isLoading: false, isAuthenticated: true }),
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa" }, botUsername: "reiwa_test_bot" }),
}));

// The hero and the two lists each pull their own queries and effects in; this
// keeps the spec about the page's decision. The points row itself is NOT
// mocked — it is the thing under test.
vi.mock("../src/features/referrals/components/invite-link-hero", () => ({
  InviteLinkHero: () => <div data-testid="invite-hero" />,
}));
vi.mock("../src/features/partner/components/partner-referrals-list", () => ({
  PartnerReferralsList: () => <div data-testid="partner-referrals-list" />,
}));
vi.mock("../src/features/partner/components/partner-advertising-section", () => ({
  PartnerAdvertisingSection: () => <div data-testid="partner-ads" />,
}));

import PartnerPage from "../src/features/partner/partner-page";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function pointsRow(): HTMLElement | null {
  return container?.querySelector<HTMLElement>("[data-testid='partner-referral-points']") ?? null;
}

function exchangeButton(): HTMLButtonElement | null {
  return (
    container?.querySelector<HTMLButtonElement>("[data-testid='partner-exchange-points']") ?? null
  );
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
        <PartnerPage />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Settle races: React Query registers its notification timer after the one
  // `settle()` opened, both at 0 ms. Microtasks always drain ahead of timers,
  // so this keeps the re-render inside the open act scope under full-suite
  // load. Same reason as `plans-page-at-capacity.test.tsx`.
  notifyManager.setScheduler(queueMicrotask);
  api.getPartnerInfo.mockReset();
  api.getPartnerEarnings.mockReset();
  api.getPartnerWithdrawals.mockReset();
  navigate.mockReset();
  api.getPartnerEarnings.mockResolvedValue({ earnings: [] });
  api.getPartnerWithdrawals.mockResolvedValue({ withdrawals: [] });
});

afterEach(() => {
  notifyManager.setScheduler(defaultScheduler);
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("PartnerPage — referral points carried over from before the appointment", () => {
  it("CONTROL: renders the partner page at all, so an absence below means something", async () => {
    api.getPartnerInfo.mockResolvedValue({
      isActive: true,
      balance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      referralPoints: 0,
    });
    render();
    await settle();

    expect(text()).toContain("partner.title");
    expect(container?.querySelector("[data-testid='partner-referrals-list']")).not.toBeNull();
  });

  it("shows the row while there is something left to spend", async () => {
    api.getPartnerInfo.mockResolvedValue({
      isActive: true,
      balance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      referralPoints: 40,
    });
    render();
    await settle();

    const row = pointsRow();
    expect(row).not.toBeNull();
    // The number the customer reads, from the row itself.
    expect(
      row?.querySelector("[data-testid='partner-referral-points-value']")?.textContent,
    ).toBe("40");
    expect(row?.textContent).toContain("referrals.points");
    expect(row?.textContent).toContain("partner.pointsHint");
  });

  it("offers the exchange, which is the only way a partner can reach it", async () => {
    // The Partner tab replaced the Referral tab in the single nav slot, so
    // without this button `/referrals/exchange` is reachable from nowhere.
    api.getPartnerInfo.mockResolvedValue({
      isActive: true,
      balance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      referralPoints: 40,
    });
    render();
    await settle();

    const button = exchangeButton();
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("referrals.exchangePoints");

    await act(async () => {
      button?.click();
    });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/referrals/exchange");
  });

  it("shows neither row nor exchange at exactly zero", async () => {
    api.getPartnerInfo.mockResolvedValue({
      isActive: true,
      balance: 12_345,
      totalEarned: 20_000,
      totalWithdrawn: 0,
      referralPoints: 0,
    });
    render();
    await settle();

    expect(pointsRow()).toBeNull();
    expect(exchangeButton()).toBeNull();
    expect(text()).not.toContain("referrals.exchangePoints");
    expect(text()).not.toContain("partner.pointsHint");
    // …while the page around it is very much on screen, including the money.
    expect(text()).toContain("partner.title");
    expect(text()).toContain("123.45 ₽");
  });

  it("shows neither when the panel sends no points field at all", async () => {
    // An older panel. Absent is not zero, and neither is a number to render.
    api.getPartnerInfo.mockResolvedValue({
      isActive: true,
      balance: 12_345,
      totalEarned: 20_000,
      totalWithdrawn: 0,
    });
    render();
    await settle();

    expect(pointsRow()).toBeNull();
    expect(exchangeButton()).toBeNull();
    expect(text()).not.toContain("partner.pointsHint");
    expect(text()).toContain("partner.title");
  });

  it("shows neither when the load failed — an empty state is a claim about data", async () => {
    // A failed lookup must not be dressed up as "you have no points". Nothing
    // is said, and in particular no zero is printed.
    api.getPartnerInfo.mockRejectedValue(new Error("upstream down"));
    render();
    await settle();

    expect(pointsRow()).toBeNull();
    expect(exchangeButton()).toBeNull();
    expect(text()).not.toContain("partner.pointsHint");
    expect(text()).not.toContain("referrals.points");
  });

  it("keeps points in their own unit: no division by 100, no currency symbol", async () => {
    // 12_345 minor units is the money and renders as "123.45 ₽". 40 points is
    // a dimensionless integer and renders as "40". Merging the two pots is the
    // one thing that must never happen to this page.
    api.getPartnerInfo.mockResolvedValue({
      isActive: true,
      balance: 12_345,
      totalEarned: 20_000,
      totalWithdrawn: 0,
      referralPoints: 40,
    });
    render();
    await settle();

    const row = pointsRow();
    expect(row).not.toBeNull();
    const rowText = row?.textContent ?? "";

    expect(
      row?.querySelector("[data-testid='partner-referral-points-value']")?.textContent,
    ).toBe("40");
    expect(rowText).not.toContain("₽");
    expect(rowText).not.toContain("0.40");
    expect(rowText).not.toContain("0,40");
    // Not the money, and not the money plus the points either.
    expect(rowText).not.toContain("123.45");
    expect(rowText).not.toContain("12345");
    expect(rowText).not.toContain("12385");

    // And the money is still the money, in its own place.
    expect(text()).toContain("123.45 ₽");
  });
});
