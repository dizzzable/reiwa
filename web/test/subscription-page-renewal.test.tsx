import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { formatDate } from "../src/lib/utils";
import type { ActionPolicy, Subscription } from "../src/types/api";

const queryState = vi.hoisted(() => ({
  subscription: null as Subscription | null,
  policy: null as ActionPolicy | null,
  /** The list `lib/trial-conversion` reads; empty unless a case says otherwise. */
  subscriptions: [] as Subscription[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === "subscription"
      ? { data: queryState.subscription, isLoading: false }
      : queryKey[0] === "subscriptions"
        ? { data: { subscriptions: queryState.subscriptions }, isLoading: false, isFetched: true }
        : { data: queryState.policy, isLoading: false },
}));

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import SubscriptionPage from "../src/features/subscription/subscription-page";

function subscription(input: {
  readonly id: string;
  readonly isTrial: boolean;
  readonly trialFree?: boolean;
}): Subscription {
  return {
    id: input.id,
    status: "ACTIVE",
    isTrial: input.isTrial,
    trialFree: input.trialFree,
    userRemnaId: null,
    trafficLimit: null,
    deviceLimit: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    expireAt: "2099-01-01T00:00:00.000Z",
    url: null,
    plan: { id: "plan-1", name: "Plan", type: "BOTH" },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function policy(canRenew: boolean): ActionPolicy {
  return {
    canBuy: false,
    canRenew,
    canUpgrade: true,
    canTrial: false,
  };
}

function renewButton(markup: string): string {
  return (
    [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map(([button]) => button)
      .find((button) => button.includes("subscription.renewFull")) ?? ""
  );
}

function isDisabledButton(buttonMarkup: string): boolean {
  return /\sdisabled(?:=""|\s|>)/.test(buttonMarkup);
}

describe("legacy subscription page trial renewal explanation", () => {
  it.each([
    ["free", subscription({ id: "free-trial", isTrial: true, trialFree: true })],
    ["paid", subscription({ id: "paid-trial", isTrial: true, trialFree: false })],
  ] as const)("shows an accessible disabled Renew action for the %s trial", (_kind, sub) => {
    queryState.subscription = sub;
    queryState.policy = policy(false);

    const markup = renderToStaticMarkup(<SubscriptionPage />);
    const button = renewButton(markup);
    const descriptionId = button.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(button).not.toBe("");
    expect(isDisabledButton(button)).toBe(true);
    expect(descriptionId).toBeTruthy();
    expect(markup).toContain(`id="${descriptionId}"`);
    expect(markup).toContain('role="note"');
    expect(markup).toContain("renewal.reason.trial");
  });

  it("keeps an ordinary renewable subscription enabled without a trial warning", () => {
    queryState.subscription = subscription({ id: "regular", isTrial: false });
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = policy(true);

    const markup = renderToStaticMarkup(<SubscriptionPage />);
    const button = renewButton(markup);

    expect(button).not.toBe("");
    expect(isDisabledButton(button)).toBe(false);
    expect(button).not.toContain("aria-describedby");
    expect(markup).not.toContain("renewal.reason.trial");
  });
});

// The owner, 24.09.2026: a subscription with no end date stays without one, so
// «Продлить подписку» is not offered, and the page says why.
describe("legacy subscription page for a subscription with no end date", () => {
  it.each([
    ["its own missing date, beside an older panel's RENEW", { expiresAt: null, expireAt: undefined }, { ...policy(true) }],
    ["the panel's word, over the date the page shows", {}, { ...policy(false), lifetime: true }],
  ] as const)("keeps Renew disabled and explains it, on %s", (_by, dates, answer) => {
    queryState.subscription = { ...subscription({ id: "lifetime", isTrial: false }), ...dates };
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = answer;

    const markup = renderToStaticMarkup(<SubscriptionPage />);
    const button = renewButton(markup);
    const descriptionId = button.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(button).not.toBe("");
    expect(isDisabledButton(button)).toBe(true);
    expect(markup).toContain(`id="${descriptionId}"`);
    expect(markup).toContain("renewal.reason.lifetime");
  });
});

// The owner, 24.09.2026: nor is its plan changed by a purchase — an upgrade
// restarts the term at the payment. «Улучшить план» is disabled and says why;
// a trial is still upgraded.
describe("legacy subscription page «Улучшить план» for a subscription with no end date", () => {
  function upgradeButton(markup: string): string {
    return (
      [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
        .map(([button]) => button)
        .find((button) => button.includes("subscription.upgradePlan")) ?? ""
    );
  }

  it.each([
    ["its own missing date, beside an older panel's UPGRADE", { expiresAt: null, expireAt: undefined }, policy(true)],
    ["the panel's word, which closes UPGRADE", {}, { ...policy(false), canUpgrade: false, lifetime: true }],
  ] as const)("is disabled and explained, on %s", (_by, dates, answer) => {
    queryState.subscription = { ...subscription({ id: "lifetime", isTrial: false }), ...dates };
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = answer;

    const markup = renderToStaticMarkup(<SubscriptionPage />);
    const button = upgradeButton(markup);
    const descriptionId = button.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(button).not.toBe("");
    expect(isDisabledButton(button)).toBe(true);
    expect(descriptionId).toBeTruthy();
    expect(markup).toContain(`id="${descriptionId}"`);
    expect(markup).toContain("upgrade.lifetime");
  });

  it("keeps it for a trial with no end date: an upgrade is how a trial is left", () => {
    queryState.subscription = { ...subscription({ id: "trial", isTrial: true, trialFree: true }), expiresAt: null, expireAt: undefined };
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = policy(false);

    const markup = renderToStaticMarkup(<SubscriptionPage />);

    expect(isDisabledButton(upgradeButton(markup))).toBe(false);
    expect(markup).not.toContain("upgrade.lifetime");
  });

  it("control: a subscription with a date keeps «Улучшить план» enabled, with no note", () => {
    queryState.subscription = subscription({ id: "dated", isTrial: false });
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = policy(true);

    const markup = renderToStaticMarkup(<SubscriptionPage />);
    const button = upgradeButton(markup);

    expect(button).not.toBe("");
    expect(isDisabledButton(button)).toBe(false);
    expect(markup).not.toContain("upgrade.lifetime");
  });
});

// The owner, 24.09.2026: «Истекает» showed «—». The page read the legacy
// `expireAt`, and the panel sends the date as `expiresAt`.
describe("legacy subscription page «Истекает»", () => {
  function expiresTile(markup: string): string | undefined {
    return markup.match(/subscription\.expires<\/p><p[^>]*>([^<]*)<\/p>/)?.[1];
  }

  it("shows the date the panel sends, and the days left", () => {
    const expiresAt = new Date(Date.now() + 10 * 86_400_000 + 3_600_000).toISOString();
    queryState.subscription = { ...subscription({ id: "dated", isTrial: false }), expiresAt, expireAt: undefined };
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = policy(true);

    const markup = renderToStaticMarkup(<SubscriptionPage />);

    expect(expiresTile(markup)).toBe(formatDate(expiresAt));
    expect(expiresTile(markup)).not.toBe("—");
    expect(markup).toContain("subscription.daysLeftShort");
    expect(markup).not.toContain("subscription.expiresInWarning");
  });

  it("warns of an end within three days from that date alone", () => {
    queryState.subscription = {
      ...subscription({ id: "ending", isTrial: false }),
      expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      expireAt: undefined,
    };
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = policy(true);

    expect(renderToStaticMarkup(<SubscriptionPage />)).toContain("subscription.expiresInWarning");
  });

  it("still reads the legacy name from an answer that sends only it", () => {
    const expireAt = "2099-01-01T00:00:00.000Z";
    queryState.subscription = { ...subscription({ id: "legacy", isTrial: false }), expiresAt: undefined as never, expireAt };
    queryState.subscriptions = [queryState.subscription];
    queryState.policy = policy(true);

    expect(expiresTile(renderToStaticMarkup(<SubscriptionPage />))).toBe(formatDate(expireAt));
  });
});

// Buying beside a trial converts it (`lib/trial-conversion`). The panel then
// closes «buy another» (`canBuy`), and without multi-subscription the account
// reads as full — yet buying is exactly what converts the trial.
describe("legacy subscription page beside a trial", () => {
  it("offers to buy, not «limit reached»", () => {
    const trial = subscription({ id: "trial", isTrial: true, trialFree: true });
    queryState.subscription = trial;
    queryState.subscriptions = [trial];
    queryState.policy = {
      ...policy(false),
      canBuy: false,
      activeSubscriptionCount: 1,
      maxSubscriptions: 1,
      limitReached: true,
    };

    const markup = renderToStaticMarkup(<SubscriptionPage />);

    expect(markup).toContain("subscription.buyForTrial");
    expect(markup).not.toContain("subscription.buyNew");
    expect(markup).not.toContain("subscription.limitReached");
  });

  it("still says «limit reached» to a full account without a trial", () => {
    const paid = subscription({ id: "paid", isTrial: false });
    queryState.subscription = paid;
    queryState.subscriptions = [paid];
    queryState.policy = {
      ...policy(false),
      canBuy: false,
      activeSubscriptionCount: 1,
      maxSubscriptions: 1,
      limitReached: true,
    };

    const markup = renderToStaticMarkup(<SubscriptionPage />);

    expect(markup).toContain("subscription.limitReached");
    expect(markup).not.toContain("subscription.buyForTrial");
  });
});
