/**
 * Bottom-navigation geometry
 * ──────────────────────────
 * ONE source for the size of the floating pill and for the room the cabinet's
 * scroller keeps free underneath it.
 *
 * The navigation is no longer an in-flow child of `.app-shell` — it hangs over
 * the content (see `.bottom-nav-floating` in `index.css`), because an in-flow
 * child of a flex column cuts itself a full-width row and that empty row IS the
 * "footer around the navbar" operators kept reporting. Out of flow, the room
 * the last card needs in order to scroll clear of the capsule has to be given
 * back to the scroller explicitly, and that room is the pill's own height.
 *
 * So: reserved room and pill size are one measurement seen from two sides, and
 * they are exported from here for exactly that reason. Split them and a pill
 * that grows by a few pixels hides the bottom of every long page — silently,
 * on phones only, where nobody runs the layout.
 *
 * The pill applies these values to its elements directly rather than through
 * utility classes with the same numbers baked in. A class list is a place the
 * arithmetic below can go stale without anything noticing;
 * `bottom-nav-floating-pill.test.tsx` reads both sides back off the rendered
 * DOM and fails when they drift apart.
 */

/** Root font size the cabinet inherits; every `rem` utility resolves against it. */
const ROOT_FONT_SIZE_PX = 16;

/**
 * Height of one destination. Was `min-h-[52px]`, and it governs the capsule:
 * the tallest content a tab can hold is icon (20) + gap (4) + label (10) +
 * `py-2` (16) = 50px, so the minimum is what the box actually measures.
 */
export const BOTTOM_NAV_ITEM_HEIGHT_PX = 52;

/** The glass capsule's vertical padding, one side. Was `py-1.5` (0.375rem). */
export const BOTTOM_NAV_CAPSULE_PADDING_Y_PX = 0.375 * ROOT_FONT_SIZE_PX;

/** The capsule's hairline, one side. Was the `border` utility (1px). */
export const BOTTOM_NAV_CAPSULE_BORDER_PX = 1;

/** How far the capsule floats above the foot of the shell. Was `mb-3` (0.75rem). */
export const BOTTOM_NAV_CAPSULE_OFFSET_PX = 0.75 * ROOT_FONT_SIZE_PX;

/**
 * The capsule's border box: one destination plus the capsule's own padding and
 * hairline on both sides — 52 + 2×6 + 2×1 = 66px.
 */
export const BOTTOM_NAV_CAPSULE_HEIGHT_PX =
  BOTTOM_NAV_ITEM_HEIGHT_PX +
  2 * BOTTOM_NAV_CAPSULE_PADDING_Y_PX +
  2 * BOTTOM_NAV_CAPSULE_BORDER_PX;

/**
 * Everything the pill takes out of the bottom of the screen above the safe
 * area: the capsule plus the gap it floats on — 66 + 12 = 78px.
 *
 * The safe-area inset is deliberately NOT folded in. It is not a length at
 * build time (only the browser knows it), and the `<nav>` already pays it as
 * its own `padding-bottom`, below the capsule's gap — so the two are stacked,
 * and `BOTTOM_NAV_CONTENT_INSET` adds them in the one place that can.
 */
export const BOTTOM_NAV_OCCUPIED_HEIGHT_PX =
  BOTTOM_NAV_CAPSULE_HEIGHT_PX + BOTTOM_NAV_CAPSULE_OFFSET_PX;

/**
 * The room the cabinet's scroller keeps below its content so any page can be
 * scrolled clear of the pill, home indicator included.
 *
 * Padding on the scroller rather than a trailing spacer element: the scroller's
 * height is set by the flex column and `box-sizing` is border-box globally, so
 * padding also shrinks the content box that `h-full` pages centre themselves
 * in. A spacer would leave those pages centring behind the capsule instead.
 */
export const BOTTOM_NAV_CONTENT_INSET = `calc(${BOTTOM_NAV_OCCUPIED_HEIGHT_PX}px + env(safe-area-inset-bottom, 0px))`;
