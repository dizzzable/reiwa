// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionCarouselPagination } from "../src/features/dashboard/components/subscription-carousel";

describe("SubscriptionCarouselPagination accessibility", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("provides 24px targets, current state and visible keyboard focus", () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <SubscriptionCarouselPagination
          count={3}
          activeIndex={1}
          disabled={false}
          onSelect={onSelect}
          getLabel={(index) => `Subscription ${index + 1}`}
        />,
      );
    });

    const dots = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "button[data-subscription-carousel-dot]",
      ),
    );
    expect(dots).toHaveLength(3);
    for (const [index, dot] of dots.entries()) {
      expect(dot.className).toContain("h-6");
      expect(dot.className).toContain("w-6");
      expect(dot.className).toContain("focus-visible:ring-2");
      expect(dot.getAttribute("aria-label")).toBe(
        `Subscription ${index + 1}`,
      );
      expect(dot.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(dots.filter((dot) => dot.getAttribute("aria-current") === "true"))
      .toHaveLength(1);
    expect(dots[1].firstElementChild?.className).toContain("w-4");

    act(() => {
      dots[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(2);

    act(() => root.unmount());
  });
});
