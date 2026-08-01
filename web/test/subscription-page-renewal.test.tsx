import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ActionPolicy, Subscription } from "../src/types/api";

const queryState = vi.hoisted(() => ({
  subscription: null as Subscription | null,
  policy: null as ActionPolicy | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === "subscription"
      ? { data: queryState.subscription, isLoading: false }
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
    queryState.policy = policy(true);

    const markup = renderToStaticMarkup(<SubscriptionPage />);
    const button = renewButton(markup);

    expect(button).not.toBe("");
    expect(isDisabledButton(button)).toBe(false);
    expect(button).not.toContain("aria-describedby");
    expect(markup).not.toContain("renewal.reason.trial");
  });
});
