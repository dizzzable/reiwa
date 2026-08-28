// @vitest-environment jsdom

/**
 * The sidebar referral card only ever says what the panel says
 * ════════════════════════════════════════════════════════════
 * Every line on this card is a claim about what the payout engine will do for
 * the person reading it, and each one has a cheap way to become false:
 *
 *   • the operator turns the program off and the card keeps advertising it;
 *   • the reward unit is hardcoded, so an install that pays DAYS is told it
 *     earns POINTS (or the reverse) — the same number, a different promise;
 *   • a configured type with a zero amount is read as "0 points" rather than
 *     "nothing is granted", which is what `createConfiguredRewards` does with
 *     it: it creates no reward row at all;
 *   • the panel is older than the `program` field, the key is absent, and
 *     `undefined` is treated as `{ enabled: true }`.
 *
 * None of those show up as a crash, a failed request or a console warning.
 * They show up as a card that quietly promises the wrong thing, which is why
 * each has a case here rather than a comment.
 *
 * The visibility assertions are paired with a positive control: a component
 * that rendered nothing at all would satisfy every "is hidden" test perfectly.
 */

import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getReferralSummary: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
// Keys, not prose: an assertion on Russian copy would fail the day a wording
// tweak lands, and pass the day the wrong KEY is chosen.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count === undefined ? key : `${key}:${opts.count}`,
  }),
}));

import { ReferralInviteCard } from "../src/components/layout/referral-invite-card";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const BASE = {
  totalReferrals: 0,
  qualifiedReferrals: 0,
  pointsBalance: 0,
  programAvailable: true,
  referralCode: "user-1",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  notifyManager.setScheduler(queueMicrotask);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  api.getReferralSummary.mockReset();
  notifyManager.setScheduler(defaultScheduler);
});

async function render(summary: unknown): Promise<HTMLDivElement> {
  api.getReferralSummary.mockResolvedValue(summary);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <ReferralInviteCard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // One resolution to flush; the card renders nothing until the summary lands.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

function card(): Element | null {
  return container?.querySelector('[data-testid="side-referral-card"]') ?? null;
}

describe("referral invite card", () => {
  it("names the reward in the unit the operator configured", async () => {
    await render({ ...BASE, program: { enabled: true, reward: { type: "POINTS", amount: 50 } } });
    expect(card()).not.toBeNull();
    expect(container?.textContent).toContain("referrals.cardRewardPoints:50");
    // The wrong-unit failure is silent, so the absence is asserted too.
    expect(container?.textContent).not.toContain("referrals.cardRewardDays");
  });

  it("switches to days when that is what the program pays", async () => {
    await render({ ...BASE, program: { enabled: true, reward: { type: "EXTRA_DAYS", amount: 7 } } });
    expect(container?.textContent).toContain("referrals.cardRewardDays:7");
    expect(container?.textContent).not.toContain("referrals.cardRewardPoints");
  });

  it("still invites, but promises nothing, when no reward is configured", async () => {
    // `reward: null` is the panel saying the engine would create nothing at
    // level 1. Under INVITED access an invite is still worth something — it is
    // what admits a friend at all — so the card stays and drops the number.
    await render({ ...BASE, program: { enabled: true, reward: null } });
    expect(card()).not.toBeNull();
    expect(container?.textContent).toContain("referrals.subtitle");
    expect(container?.textContent).not.toContain("referrals.cardReward");
  });

  it("disappears when the operator switched the program off", async () => {
    await render({ ...BASE, program: { enabled: false, reward: { type: "POINTS", amount: 50 } } });
    // A configured reward is still in the JSON — `enabled` alone has to be
    // enough, or the kill-switch does not kill anything a user can see.
    expect(card()).toBeNull();
  });

  it("disappears when the invited-only gate excludes this user", async () => {
    await render({
      ...BASE,
      programAvailable: false,
      program: { enabled: true, reward: { type: "POINTS", amount: 50 } },
    });
    expect(card()).toBeNull();
  });

  it("disappears against a panel too old to state the terms", async () => {
    // No `program` key at all. `undefined` must not read as "enabled": there
    // would be no reward to name and no way to know the program is even on.
    await render(BASE);
    expect(card()).toBeNull();
  });

  it("counts nothing until there is something to count", async () => {
    const empty = await render({
      ...BASE,
      program: { enabled: true, reward: { type: "POINTS", amount: 50 } },
    });
    // Positive control: the card IS there, so the missing labels below are a
    // statement about the stats block and not about an empty render.
    expect(empty.querySelector('[data-testid="side-referral-card"]')).not.toBeNull();
    expect(empty.textContent).not.toContain("referrals.invited");

    act(() => root?.unmount());
    container?.remove();

    const counted = await render({
      ...BASE,
      totalReferrals: 12,
      qualifiedReferrals: 3,
      program: { enabled: true, reward: { type: "POINTS", amount: 50 } },
    });
    expect(counted.textContent).toContain("referrals.invited");
    expect(counted.textContent).toContain("referrals.qualified");
    expect(counted.textContent).toContain("12");
    expect(counted.textContent).toContain("3");
  });

  it("leads to the referrals page", async () => {
    await render({ ...BASE, program: { enabled: true, reward: { type: "POINTS", amount: 50 } } });
    expect(card()?.getAttribute("href")).toBe("/referrals");
  });

  it("takes every colour from a theme token, never a literal", async () => {
    await render({ ...BASE, program: { enabled: true, reward: { type: "POINTS", amount: 50 } } });
    // The operator's palette arrives as CSS custom properties at runtime, so a
    // Tailwind colour-scale class here would be a colour the theme cannot
    // reach — exactly how the referrals page ended up with a hardcoded violet
    // and amber that follow no brand at all.
    const markup = card()?.outerHTML ?? "";
    expect(markup).toContain("--brand-primary");
    expect(markup).not.toMatch(/\b(?:bg|text|border)-(?:red|violet|amber|emerald|sky|rose|zinc|slate|gray)-\d{2,3}\b/);
  });
});
