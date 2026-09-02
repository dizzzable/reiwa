// @vitest-environment jsdom

/**
 * The points ledger says only what the panel said, and nothing the operator
 * wrote to themselves.
 * ══════════════════════════════════════════════════════════════════════════
 * Four failures this list can have, none of which announces itself:
 *
 *   • A panel older than the ledger route answers 404. Rendering an error
 *     card there tells the customer something broke when nothing did;
 *     rendering the empty state tells them they have earned nothing, which
 *     is a different false statement. The only honest output is none.
 *   • MANUAL_ADJUSTMENT details carry `note` and `adminId` — operator
 *     bookkeeping that ships in the same object as the reason label. One
 *     `{JSON.stringify(details)}` and a customer reads their own case
 *     notes. The absence is asserted, because nothing else would catch it.
 *   • "Show more" is keyset pagination: it has to hand back the cursor it
 *     was given. Passing `undefined` (or a page number) still renders rows
 *     — the FIRST page, again, forever.
 *   • A real failure has to stay a failure. If the 404 branch widened to
 *     every error, an outage would silently look like an empty program.
 *
 * Assertions are on i18n KEYS, not on Russian copy: a wording tweak must
 * not fail this, and choosing the wrong key must.
 */

import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getPointsLedger: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: "ru" },
  }),
}));

import { PointsHistoryList } from "../src/features/referrals/components/points-history-list";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const CASHBACK_ROW = {
  id: "e1",
  delta: 150,
  balanceAfter: 1150,
  source: "CASHBACK",
  referenceKey: "pay_1",
  details: {
    paidAmount: "499.00",
    paidCurrency: "RUB",
    lines: [{ kind: "PLAN", name: "Pro", durationDays: 30, points: 150 }],
  },
  createdAt: "2026-08-01T10:00:00.000Z",
};

const ADJUSTMENT_ROW = {
  id: "e2",
  delta: -40,
  balanceAfter: 1000,
  source: "MANUAL_ADJUSTMENT",
  referenceKey: null,
  details: {
    reason: "VIOLATION",
    note: "abused the promo, see ticket 812",
    adminId: "adm_7",
  },
  createdAt: "2026-07-30T09:00:00.000Z",
};

const FIRST_PAGE = { items: [CASHBACK_ROW, ADJUSTMENT_ROW], nextCursor: "cursor-2" };

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

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    // The component owns its own `retry` policy (it must not retry a 404),
    // so the delay is what the test can shorten — otherwise the generic
    // error case sits through the default 1s/2s backoff.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <PointsHistoryList />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function notFoundError(): Error {
  return Object.assign(new Error("Request failed with status code 404"), {
    response: { status: 404, data: { message: "Points history not available" } },
  });
}

beforeEach(() => {
  notifyManager.setScheduler(queueMicrotask);
  api.getPointsLedger.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  notifyManager.setScheduler(defaultScheduler);
});

describe("points history list", () => {
  it("names every row by its source and signs the delta", async () => {
    api.getPointsLedger.mockResolvedValue(FIRST_PAGE);
    await render();

    expect(api.getPointsLedger).toHaveBeenNthCalledWith(1, null, 20);
    expect(text()).toContain("pointsHistory.sources.CASHBACK");
    expect(text()).toContain("pointsHistory.sources.MANUAL_ADJUSTMENT");
    // A credit and a debit have to be told apart at a glance; the sign is
    // the whole of that signal, and `+` is not in the number.
    expect(text()).toContain("+150");
    expect(text()).toContain("-40");
    expect(text()).toContain("pointsHistory.balanceAfter");
    expect(text()).toContain("1150");
  });

  it("spells out what a cashback row was paid for", async () => {
    api.getPointsLedger.mockResolvedValue(FIRST_PAGE);
    await render();

    expect(text()).toContain("pointsHistory.details.cashback");
    expect(text()).toContain("Pro");
    expect(text()).toContain("pointsHistory.details.days");
    expect(text()).toContain("499.00 RUB");
  });

  it("shows the operator's REASON and never the operator's note", async () => {
    api.getPointsLedger.mockResolvedValue(FIRST_PAGE);
    await render();

    expect(text()).toContain("pointsHistory.reasons.VIOLATION");
    // Both ship inside the same `details` object as the reason above, so the
    // positive assertion is the control: the payload was read, and these two
    // fields were left out on purpose.
    expect(text()).not.toContain("abused the promo");
    expect(text()).not.toContain("adm_7");
  });

  it("hands the cursor back when asked for more", async () => {
    api.getPointsLedger.mockResolvedValueOnce(FIRST_PAGE);
    api.getPointsLedger.mockResolvedValueOnce({
      items: [{ ...CASHBACK_ROW, id: "e3", source: "REFERRAL_REWARD", details: null }],
      nextCursor: null,
    });
    await render();

    const more = buttonSaying("pointsHistory.showMore");
    expect(more).not.toBeNull();
    await act(async () => {
      more?.click();
    });
    await settle();

    expect(api.getPointsLedger).toHaveBeenNthCalledWith(2, "cursor-2", 20);
    expect(text()).toContain("pointsHistory.sources.REFERRAL_REWARD");
    // Last page: the invitation to load more has to go, or it re-fetches
    // the same final page on every tap.
    expect(buttonSaying("pointsHistory.showMore")).toBeNull();
  });

  it("says nothing at all when the panel has no such route", async () => {
    api.getPointsLedger.mockRejectedValue(notFoundError());
    await render();

    // Not the error card, not the empty state, not the heading.
    expect(text()).toBe("");
  });

  it("still reports a real failure", async () => {
    api.getPointsLedger.mockRejectedValue(new Error("network down"));
    await render();

    expect(text()).toContain("pointsHistory.loadError");
    expect(buttonSaying("pointsHistory.retry")).not.toBeNull();
    // The 404 branch must not have widened to swallow this one.
    expect(text()).toContain("pointsHistory.title");
  });

  it("offers the empty state, not silence, when the ledger is simply empty", async () => {
    api.getPointsLedger.mockResolvedValue({ items: [], nextCursor: null });
    await render();

    expect(text()).toContain("pointsHistory.empty");
    expect(buttonSaying("pointsHistory.showMore")).toBeNull();
  });
});
