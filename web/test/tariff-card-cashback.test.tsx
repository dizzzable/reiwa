// @vitest-environment jsdom

/**
 * Loyalty cashback on the tariff card.
 *
 * The card summarises a WHOLE plan and never commits to a duration, so the one
 * honest number it can show is the best on offer — hence "up to". Two things
 * are pinned here, and both have a way of going wrong quietly:
 *
 *  - the maximum is taken across durations, ignoring `null`/`0`/absent, so a
 *    plan whose cheapest month earns nothing still advertises what its year
 *    earns (a `durations[0]` shortcut would pass a one-duration fixture);
 *  - a plan with no cashback at all says NOTHING. `t()` echoes its key here, so
 *    a `count: 0` slipping through would render visible copy, not empty space.
 *
 * The price pill is asserted alongside as a control: a "fix" that stopped
 * rendering the bottom row would otherwise satisfy the negative case.
 */

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Plan, PlanDuration } from "../src/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Echo key + interpolation so the count is assertable without depending on
    // Russian copy or on i18next's plural resolution.
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock("motion/react", () => ({
  motion: {
    button: ({
      children,
      initial: _initial,
      animate: _animate,
      transition: _transition,
      ...props
    }: ComponentProps<"button"> & {
      initial?: unknown;
      animate?: unknown;
      transition?: unknown;
    }) => <button {...props}>{children}</button>,
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  },
}));

vi.mock("@/lib/branding-provider", async () => {
  const { DEFAULT_BRANDING } = await import("@/types/branding");
  return {
    useBranding: () => ({
      branding: DEFAULT_BRANDING,
      defaultCurrency: "USD",
      customIcons: [],
    }),
  };
});

// The WebGL budget and the effect layer are the card's other half and have
// their own specs; neither has a say in the pill.
vi.mock("@/lib/card-effect-budget", () => ({
  useCardEffectSlot: () => ({ ref: () => undefined, active: false }),
}));
vi.mock("@/components/reactbits/card-effect-layer", () => ({
  CardEffectLayer: () => null,
}));
vi.mock("@/components/ui/card-watermark", () => ({
  CardWatermark: () => null,
}));

import { TariffCard } from "../src/features/plans/tariff-card";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function duration(
  id: string,
  days: number,
  price: string,
  cashbackPoints?: number | null,
): PlanDuration {
  return {
    id,
    days,
    prices: [{ currency: "USD", price }],
    ...(cashbackPoints === undefined ? {} : { cashbackPoints }),
  };
}

function plan(durations: PlanDuration[]): Plan {
  return {
    id: "plan-cashback",
    name: "Basic",
    description: null,
    tag: null,
    type: "UNLIMITED",
    availability: "AVAILABLE",
    trafficLimit: null,
    deviceLimit: null,
    trafficLimitStrategy: "NO_RESET",
    orderIndex: 0,
    durations,
  };
}

function render(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

function text(): string {
  return container?.textContent ?? "";
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("TariffCard cashback badge", () => {
  it("advertises the best cashback across the plan's durations", () => {
    render(
      <TariffCard
        plan={plan([
          duration("d1", 30, "5.00", 5),
          duration("d2", 90, "12.00", 13),
          duration("d3", 180, "20.00", null),
        ])}
        onClick={() => undefined}
      />,
    );

    expect(text()).toContain('plans.cashbackUpTo:{"count":13}');
    // Not the first duration's, and not the last one's absence.
    expect(text()).not.toContain('plans.cashbackUpTo:{"count":5}');
    // Control: the rest of the bottom row is untouched.
    expect(text()).toContain("plans.from");
  });

  it("says nothing when no duration pays anything back", () => {
    render(
      <TariffCard
        plan={plan([
          duration("d1", 30, "5.00", null),
          duration("d2", 90, "12.00", 0),
          duration("d3", 180, "20.00"),
        ])}
        onClick={() => undefined}
      />,
    );

    expect(text()).not.toContain("plans.cashbackUpTo");
    // Control: the card itself still rendered, so the assertion above is about
    // the badge and not about a card that failed to mount.
    expect(text()).toContain("plans.from");
    expect(text()).toContain("plans.durationOptions");
  });
});
