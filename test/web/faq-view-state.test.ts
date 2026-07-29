import { describe, expect, it } from "vitest";

import type { FaqItem } from "../../web/src/lib/api-client/content.js";
import { resolveFaqViewState } from "../../web/src/features/settings/faq-state.js";

const t = (key: string) => key;

describe("FAQ view state", () => {
  it("shows the operator-managed FAQ without an outage banner when the query succeeds", () => {
    const items: FaqItem[] = [{ id: "faq-1", question: "How?", answer: "Like this" }];

    expect(resolveFaqViewState(items, false, t)).toEqual({
      items,
      showLoadError: false,
      showEmptyState: false,
    });
  });

  it("respects an intentionally empty operator-managed FAQ", () => {
    expect(resolveFaqViewState([], false, t)).toEqual({
      items: [],
      showLoadError: false,
      showEmptyState: true,
    });
  });

  it("surfaces the outage while keeping the built-in FAQ fallback available", () => {
    const state = resolveFaqViewState(undefined, true, t);

    expect(state.showLoadError).toBe(true);
    expect(state.showEmptyState).toBe(false);
    expect(state.items).toEqual([
      { id: "1", question: "faq.q1", answer: "faq.a1" },
      { id: "2", question: "faq.q2", answer: "faq.a2" },
      { id: "3", question: "faq.q3", answer: "faq.a3" },
      { id: "4", question: "faq.q4", answer: "faq.a4" },
    ]);
  });
});
