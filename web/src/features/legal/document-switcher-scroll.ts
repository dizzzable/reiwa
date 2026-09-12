/**
 * Where the document switcher's pill row has to be scrolled so the pill for the
 * document being read is actually on screen.
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * On a phone the switcher is a horizontal row of pills wider than the screen.
 * Arriving at `/legal#doc-offer` — which is the whole point of addressing the
 * documents in the URL, because that is the link the bot and the sign-up form
 * hand out — renders the right document with the row still at `scrollLeft: 0`.
 * Measured in Chrome at 375px with three documents: the active pill sat at
 * x=453 in a 607px row, i.e. entirely past the right edge. The reader sees the
 * correct text under a switcher in which NOTHING appears selected, and has to
 * discover by swiping sideways that there is a selection at all.
 *
 * ── Why the arithmetic lives here and not inside the effect ─────────────────
 *
 * jsdom has no layout engine: every rect, `clientWidth` and `scrollWidth` is 0
 * there, so a test that rendered the row and read back `scrollLeft` would be
 * asserting zeroes and would pass with this file deleted. The part that can be
 * WRONG is the arithmetic, so the arithmetic is separated out and tested with
 * real numbers; the component keeps only the adapter that reads the two rects.
 * Same reasoning as `legal-document-outline.ts`, and the same reasoning the
 * out-of-shell scroller test spells out for its own blind spot.
 */

/** The row, in the numbers a scroll container reports about itself. */
export interface SwitcherRow {
  /** Where the row is scrolled to now. */
  readonly scrollLeft: number;
  /** Visible width of the row. */
  readonly clientWidth: number;
  /** Total width of the pills. Equal to `clientWidth` when nothing overflows. */
  readonly scrollWidth: number;
  /** The row's own left edge in viewport coordinates. */
  readonly left: number;
}

/** The active pill, in viewport coordinates. */
export interface SwitcherPill {
  readonly left: number;
  readonly width: number;
}

/**
 * The `scrollLeft` that centres the active pill, or `null` when the row should
 * be left exactly as it is.
 *
 * `null` is returned in the two cases where moving the row would be wrong
 * rather than merely unnecessary:
 *
 *   - **the row does not scroll.** On a wide screen the same element is laid
 *     out as a column with `overflow: visible`, so `scrollWidth` equals
 *     `clientWidth`. Writing a scroll offset there is meaningless, and saying
 *     so here keeps the caller from having to know about the breakpoint.
 *   - **the pill is already whole on screen.** A reader who has swiped the row
 *     to look at the other documents should not have it yanked back under
 *     their finger, and on the common case — first document, row at rest —
 *     there is nothing to do.
 *
 * The result is clamped to the row's real scroll range, so the last pill
 * cannot ask for an offset past the end and leave a gap.
 */
export function switcherScrollLeft(row: SwitcherRow, pill: SwitcherPill): number | null {
  if (row.scrollWidth <= row.clientWidth) return null;

  // The pill's position in the row's own scroll coordinates: where it sits on
  // screen, plus however far the row is already scrolled.
  const offset = row.scrollLeft + (pill.left - row.left);
  const visibleStart = row.scrollLeft;
  const visibleEnd = visibleStart + row.clientWidth;
  if (offset >= visibleStart && offset + pill.width <= visibleEnd) return null;

  const centred = offset - (row.clientWidth - pill.width) / 2;
  const furthest = row.scrollWidth - row.clientWidth;
  return Math.max(0, Math.min(centred, furthest));
}
