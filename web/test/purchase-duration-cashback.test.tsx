// @vitest-environment jsdom

/**
 * Loyalty cashback on the duration step.
 *
 * The tariff card can only say "up to"; this is the screen where the buyer
 * picks a term, so it is the one place that can name the exact number they
 * will earn for the price shown next to it. A duration the panel says nothing
 * about must stay silent — the two live in the same list, so a per-row
 * condition that leaked would put a pill on every row.
 *
 * The price column is asserted alongside as a control: the pill was moved out
 * of the `displayPrice` guard, and that must not have cost the price itself.
 */

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Plan, PlanDuration } from "../src/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
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

// The step reads `lastNav` only to decide whether a single-duration plan
// auto-advances. Every fixture here has several, so the value is inert — but
// the store still has to exist for the module to mount.
vi.mock("@/stores/purchase.store", () => ({
  usePurchaseStore: (select: (s: { lastNav: string }) => unknown) => select({ lastNav: "back" }),
}));

import { SelectDuration } from "../src/features/purchase/purchase-page";

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

const PLAN: Plan = {
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
  durations: [
    duration("d1", 30, "5.00", 13),
    duration("d2", 90, "12.00", null),
    duration("d3", 180, "20.00"),
  ],
};

function text(): string {
  return container?.textContent ?? "";
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <SelectDuration plan={PLAN} preferredCurrency="USD" onSelect={() => undefined} />,
    );
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("SelectDuration cashback pill", () => {
  it("names the points a duration earns, on that duration's row only", () => {
    const rows = container?.querySelectorAll("button") ?? [];
    expect(rows.length).toBe(3);

    expect(rows[0]?.textContent).toContain('purchase.duration.cashback:{"count":13}');
    // Control: the price it is earned at is still on the same row.
    expect(rows[0]?.textContent).toContain("$5.00");

    // `null` and an absent field are the same silence.
    expect(rows[1]?.textContent).not.toContain("purchase.duration.cashback");
    expect(rows[2]?.textContent).not.toContain("purchase.duration.cashback");
    expect(rows[1]?.textContent).toContain("$12.00");
    expect(rows[2]?.textContent).toContain("$20.00");

    // Exactly one row carries it.
    expect(text().split("purchase.duration.cashback").length - 1).toBe(1);
  });
});
