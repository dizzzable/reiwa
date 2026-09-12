import { describe, expect, it } from "vitest";

import {
  switcherScrollLeft,
  type SwitcherPill,
  type SwitcherRow,
} from "@/features/legal/document-switcher-scroll";

/**
 * THE PILL FOR THE DOCUMENT BEING READ HAS TO BE ON SCREEN.
 *
 * The numbers in the first case are not invented. They were measured in Chrome
 * at a 375px viewport on `/legal#doc-offer` with the three documents an
 * operator actually configures: the row was 607px of pills inside a 375px
 * window, still at `scrollLeft: 0`, with the active pill at x=453 and 134px
 * wide — past the right edge in its entirety. The reader got the correct
 * document under a switcher in which nothing appeared selected.
 *
 * This file tests the arithmetic and ONLY the arithmetic, and says so plainly
 * because the alternative is worse: jsdom has no layout engine, so a test that
 * rendered `DocumentSwitcher` and read `scrollLeft` back would compare zero to
 * zero and stay green with the whole feature deleted. What is NOT covered here
 * is the adapter in `legal-page.tsx` that reads the two rects and writes the
 * offset — that is four lines with no branch in them beyond the null guard,
 * and it was verified in the browser instead (the pill row centres the active
 * pill on arrival at `#doc-offer`, and stays put on a wide screen).
 */

const row = (over: Partial<SwitcherRow> = {}): SwitcherRow => ({
  scrollLeft: 0,
  clientWidth: 375,
  scrollWidth: 607,
  left: 0,
  ...over,
});

const pill = (over: Partial<SwitcherPill> = {}): SwitcherPill => ({
  left: 453,
  width: 134,
  ...over,
});

describe("switcherScrollLeft", () => {
  it("brings a pill that sits past the right edge into view", () => {
    // THE DEFECT, in its measured form. Any answer that leaves the row at 0
    // reproduces it, so the assertion is that the row moves at all — and far
    // enough that the pill ends up inside the window.
    const left = switcherScrollLeft(row(), pill());
    expect(left).not.toBeNull();
    const offset = left ?? 0;
    expect(offset).toBeGreaterThan(0);
    // Pill fully inside the visible window afterwards.
    expect(453 - offset).toBeGreaterThanOrEqual(0);
    expect(453 - offset + 134).toBeLessThanOrEqual(375);
  });

  it("centres it rather than just nudging it to the edge", () => {
    // 453 - (375 - 134) / 2 = 332.5, clamped by the row's own range below.
    expect(switcherScrollLeft(row(), pill())).toBe(232);
  });

  it("never scrolls past the end of the row", () => {
    // The last pill of a long row asks to be centred at an offset the row
    // cannot reach; answering it literally would leave a strip of empty space
    // after the final pill. 607 - 375 = 232 is as far as this row goes.
    const left = switcherScrollLeft(row({ scrollWidth: 500 }), pill({ left: 460, width: 40 }));
    expect(left).toBe(125);
  });

  it("never answers a negative offset", () => {
    // Going BACK to the first document from a row that is scrolled right: the
    // pill is off the LEFT edge, and centring a pill that early asks for a
    // negative offset (5 - (375 - 134) / 2 = -115.5). The row's origin is the
    // furthest it can go in that direction.
    expect(switcherScrollLeft(row({ scrollLeft: 50 }), pill({ left: -45, width: 134 }))).toBe(0);
  });

  it("leaves a row that does not scroll alone", () => {
    // The wide-screen layout: the same element becomes a column with
    // `overflow: visible`, so nothing overflows and there is nothing to move.
    // Without this branch the effect would write a scroll offset onto a
    // column every time the reader switched documents.
    expect(switcherScrollLeft(row({ scrollWidth: 375 }), pill({ left: 0, width: 240 }))).toBeNull();
    expect(switcherScrollLeft(row({ scrollWidth: 200 }), pill({ left: 0, width: 200 }))).toBeNull();
  });

  it("leaves a pill that is already whole on screen alone", () => {
    // The common case — first document, row at rest — and the case that keeps
    // the row from being yanked back under the finger of someone who has
    // swiped it themselves.
    expect(switcherScrollLeft(row(), pill({ left: 10, width: 180 }))).toBeNull();
    // Flush against each edge still counts as whole.
    expect(switcherScrollLeft(row(), pill({ left: 0, width: 375 }))).toBeNull();
  });

  it("moves a pill that is only PARTLY visible, which is the easy one to miss", () => {
    // 300..500 in a 375-wide window: its left edge is on screen, so a check
    // written as "is the pill's left edge visible" would call this done and
    // leave the label cut in half.
    const left = switcherScrollLeft(row(), pill({ left: 300, width: 200 }));
    expect(left).not.toBeNull();
    expect(left ?? 0).toBeGreaterThan(0);
  });

  it("reads the pill's position relative to a row that is already scrolled", () => {
    // Switching documents twice in a row: the second call sees a row that has
    // moved, and a pill whose viewport position is therefore NOT its position
    // in the row's scroll coordinates. Dropping `row.left` or `row.scrollLeft`
    // from that sum is the mistake this case exists for.
    const scrolled = row({ scrollLeft: 232, left: 0 });
    // A pill drawn at x=-100 on screen is at 132 in scroll coordinates.
    const left = switcherScrollLeft(scrolled, pill({ left: -100, width: 134 }));
    expect(left).toBe(11.5);
  });

  it("respects a row that does not start at the viewport's left edge", () => {
    // The page has horizontal padding and, above `lg`, the row shares the grid
    // with the document, so its left edge is not the viewport's. A pill drawn
    // at x=500 inside a row that starts at x=200 is at 300 in that row, not at
    // 500 — and the two readings give different answers here on purpose:
    // 300 - 120.5 = 179.5 against 500 - 120.5 = 379.5, which the clamp would
    // flatten to 232 and slam the row to its end. A case where both readings
    // happen to agree would let `- row.left` be deleted unnoticed.
    const inset = row({ left: 200 });
    expect(switcherScrollLeft(inset, pill({ left: 500, width: 134 }))).toBe(179.5);
  });
});
