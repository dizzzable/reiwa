// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));

import { SubscriptionActions } from "../src/features/dashboard/components/subscription-actions";
import type { Subscription } from "../src/types/api";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function subscription(input: {
  readonly id: string;
  readonly isTrial?: boolean;
  readonly trialFree?: boolean;
  readonly expiresAt?: string | null;
}): Subscription {
  return {
    id: input.id,
    status: "ACTIVE",
    isTrial: input.isTrial as boolean,
    trialFree: input.trialFree,
    url: null,
    ...("expiresAt" in input ? { expiresAt: input.expiresAt } : {}),
  } as Subscription;
}

function renderActions(
  sub: Subscription,
  policyCanRenew: boolean | undefined,
  policyLifetime?: boolean,
): string {
  return renderToStaticMarkup(
    <SubscriptionActions
      subscription={sub}
      policyCanRenew={policyCanRenew}
      policyLifetime={policyLifetime}
      onConnect={vi.fn()}
      onUpgrade={vi.fn()}
      onRenew={vi.fn()}
    />,
  );
}

function renderActionsIntoDom(
  sub: Subscription,
  policyCanRenew: boolean | undefined,
  onRenew: () => void,
  policyLifetime?: boolean,
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <SubscriptionActions
        subscription={sub}
        policyCanRenew={policyCanRenew}
        policyLifetime={policyLifetime}
        onConnect={vi.fn()}
        onUpgrade={vi.fn()}
        onRenew={onRenew}
      />,
    );
  });
  return container;
}

function renewButton(markup: string): string {
  return (
    [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map(([button]) => button)
      .find((button) => button.includes("card.actions.renew")) ?? ""
  );
}

function isDisabledButton(buttonMarkup: string): boolean {
  return /\sdisabled(?:=""|\s|>)/.test(buttonMarkup);
}

function renewButtonElement(container: ParentNode): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes("card.actions.renew"));
  if (!button) throw new Error("Renew button was not rendered");
  return button;
}

describe("SubscriptionActions renewal guard", () => {
  it.each([
    ["free", subscription({ id: "free-trial", isTrial: true, trialFree: true })],
    ["paid", subscription({ id: "paid-trial", isTrial: true, trialFree: false })],
  ] as const)("keeps the %s trial Renew button disabled and never invokes its callback", (_kind, sub) => {
    const onRenew = vi.fn();
    const markup = renderActions(sub, true);
    const button = renewButton(markup);
    const descriptionId = button.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(isDisabledButton(button)).toBe(true);
    expect(descriptionId).toBeTruthy();
    expect(markup).toContain(`id="${descriptionId}"`);
    expect(markup).toContain('role="note"');
    expect(markup).toContain("renewal.reason.trial");

    const buttonElement = renewButtonElement(
      renderActionsIntoDom(sub, true, onRenew),
    );
    expect(buttonElement.disabled).toBe(true);
    act(() => buttonElement.click());
    expect(onRenew).not.toHaveBeenCalled();
  });

  it("fails closed when an older payload omits isTrial", () => {
    const sub = subscription({ id: "legacy-missing-trial-marker" });
    const markup = renderActions(sub, true);
    const onRenew = vi.fn();

    expect(isDisabledButton(renewButton(markup))).toBe(true);
    expect(markup).not.toContain("renewal.reason.trial");

    const buttonElement = renewButtonElement(
      renderActionsIntoDom(sub, true, onRenew),
    );
    expect(buttonElement.disabled).toBe(true);
    act(() => buttonElement.click());
    expect(onRenew).not.toHaveBeenCalled();
  });

  it("keeps an ordinary subscription enabled and invokes Renew", () => {
    const sub = subscription({ id: "regular", isTrial: false });
    const markup = renderActions(sub, true);
    const onRenew = vi.fn();

    expect(isDisabledButton(renewButton(markup))).toBe(false);
    expect(renewButton(markup)).not.toContain("aria-describedby");
    expect(markup).not.toContain("renewal.reason.trial");

    const buttonElement = renewButtonElement(
      renderActionsIntoDom(sub, true, onRenew),
    );
    expect(buttonElement.disabled).toBe(false);
    act(() => buttonElement.click());
    expect(onRenew).toHaveBeenCalledTimes(1);
  });

  // The owner, 24.09.2026: a subscription with no end date stays without one,
  // and the card says so instead of offering «Продлить».
  it.each([
    // A panel older than the rule: RENEW still open, and the row itself has no date.
    ["its own missing date, beside an older panel's RENEW", subscription({ id: "lifetime", isTrial: false, expiresAt: null }), true, undefined],
    // The list shows the VPN panel's date for it; the panel's policy says what it is.
    ["the panel's word, over the date the list shows", subscription({ id: "lifetime", isTrial: false, expiresAt: "2030-01-01T00:00:00.000Z" }), false, true],
  ] as const)(
    "keeps Renew disabled and says there is nothing to renew, on %s",
    (_by, sub, policyCanRenew, policyLifetime) => {
      const markup = renderActions(sub, policyCanRenew, policyLifetime);
      const button = renewButton(markup);
      const descriptionId = button.match(/aria-describedby="([^"]+)"/)?.[1];

      expect(isDisabledButton(button)).toBe(true);
      expect(descriptionId).toBeTruthy();
      expect(markup).toContain(`id="${descriptionId}"`);
      expect(markup).toContain("renewal.reason.lifetime");
      expect(markup).not.toContain("renewal.reason.trial");

      const onRenew = vi.fn();
      const buttonElement = renewButtonElement(renderActionsIntoDom(sub, policyCanRenew, onRenew, policyLifetime));
      expect(buttonElement.disabled).toBe(true);
      act(() => buttonElement.click());
      expect(onRenew).not.toHaveBeenCalled();
    },
  );

  it("control: a subscription with a date, and no word from the panel, renews without a note", () => {
    const markup = renderActions(
      subscription({ id: "dated", isTrial: false, expiresAt: "2030-01-01T00:00:00.000Z" }),
      true,
      false,
    );

    expect(isDisabledButton(renewButton(markup))).toBe(false);
    expect(markup).not.toContain("renewal.reason.lifetime");
  });

  it("uses the exact selected subscription policy in a multi-subscription portfolio", () => {
    const first = subscription({ id: "subscription-1", isTrial: false });
    const second = subscription({ id: "subscription-2", isTrial: false });
    const firstRenew = vi.fn();
    const secondRenew = vi.fn();

    expect(isDisabledButton(renewButton(renderActions(first, false)))).toBe(true);
    expect(isDisabledButton(renewButton(renderActions(second, true)))).toBe(false);

    const firstButton = renewButtonElement(
      renderActionsIntoDom(first, false, firstRenew),
    );
    const secondButton = renewButtonElement(
      renderActionsIntoDom(second, true, secondRenew),
    );
    act(() => {
      firstButton.click();
      secondButton.click();
    });
    expect(firstRenew).not.toHaveBeenCalled();
    expect(secondRenew).toHaveBeenCalledTimes(1);
  });
});

// The owner, 24.09.2026: a purchase does not change the plan of a subscription
// with no end date either — an upgrade restarts the term at the payment. The
// card's «Улучшить» is closed and says why; a trial is still upgraded.
describe("SubscriptionActions upgrade guard", () => {
  function upgradeButton(markup: string): string {
    return (
      [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
        .map(([button]) => button)
        .find((button) => button.includes("card.actions.upgrade")) ?? ""
    );
  }

  function upgradeButtonIntoDom(sub: Subscription, policyLifetime: boolean | undefined, onUpgrade: () => void): HTMLButtonElement {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <SubscriptionActions
          subscription={sub}
          policyCanRenew={false}
          policyLifetime={policyLifetime}
          onConnect={vi.fn()}
          onUpgrade={onUpgrade}
          onRenew={vi.fn()}
        />,
      );
    });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("card.actions.upgrade"),
    );
    if (!button) throw new Error("Upgrade button was not rendered");
    return button;
  }

  it.each([
    ["its own missing date", subscription({ id: "lifetime", isTrial: false, expiresAt: null }), undefined],
    ["the panel's word, over the date the list shows", subscription({ id: "lifetime", isTrial: false, expiresAt: "2030-01-01T00:00:00.000Z" }), true],
  ] as const)("is disabled and explained, and never invoked, on %s", (_by, sub, policyLifetime) => {
    const markup = renderActions(sub, false, policyLifetime);
    const button = upgradeButton(markup);
    const descriptionId = button.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(isDisabledButton(button)).toBe(true);
    expect(descriptionId).toBeTruthy();
    expect(markup).toContain(`id="${descriptionId}"`);
    expect(markup).toContain("upgrade.lifetime");

    const onUpgrade = vi.fn();
    const element = upgradeButtonIntoDom(sub, policyLifetime, onUpgrade);
    expect(element.disabled).toBe(true);
    act(() => element.click());
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it("stays open for a trial with no end date: an upgrade is how a trial is left", () => {
    const sub = subscription({ id: "trial", isTrial: true, trialFree: true, expiresAt: null });
    const markup = renderActions(sub, false);

    expect(isDisabledButton(upgradeButton(markup))).toBe(false);
    expect(markup).not.toContain("upgrade.lifetime");
    const onUpgrade = vi.fn();
    const element = upgradeButtonIntoDom(sub, undefined, onUpgrade);
    act(() => element.click());
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("control: a subscription with a date upgrades, with no note", () => {
    const sub = subscription({ id: "dated", isTrial: false, expiresAt: "2030-01-01T00:00:00.000Z" });
    const markup = renderActions(sub, true, false);

    expect(isDisabledButton(upgradeButton(markup))).toBe(false);
    expect(markup).not.toContain("upgrade.lifetime");
    const onUpgrade = vi.fn();
    const element = upgradeButtonIntoDom(sub, false, onUpgrade);
    act(() => element.click());
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});
