/**
 * What a drag inside the viewer means.
 *
 * One drag can plausibly be three things — turn the page, move a magnified
 * image, or throw the viewer away — and picking wrong is the difference between
 * a viewer that feels native and one that fights the user. The rules are here,
 * as data, so they can be argued with and tested rather than rediscovered by
 * swiping on a phone.
 */

export type DragIntent = 'PAGE' | 'PAN' | 'DISMISS';

/**
 * Movement before a drag is claimed by anything.
 *
 * Below this the gesture is still a tap: a finger that moves three pixels while
 * pressing a picture must not slide it, or double tap to zoom becomes unusable
 * for anyone whose hands are not perfectly still.
 */
export const DRAG_INTENT_THRESHOLD_PX = 8;

/** A horizontal throw past this share of the viewport turns the page. */
export const PAGE_COMMIT_FRACTION = 0.25;

/** A downward throw past this many pixels closes the viewer. */
export const DISMISS_COMMIT_PX = 110;

/**
 * Decides once, at the start of a drag, what the whole drag will do.
 *
 * Two deliberate rules:
 *
 *  1. **Magnified means pan, always.** Not "pan until the image hits its edge,
 *     then page" — the version that quietly turns the page when a person
 *     reading the left side of a zoomed screenshot pushes a little too far.
 *     Reading is the reason zoom exists here, so a magnified image owns every
 *     drag and the way out is to zoom back out.
 *  2. **Otherwise the dominant axis wins.** Horizontal turns the page, vertical
 *     dismisses. The intent is locked in for the rest of the gesture by the
 *     caller, so a drag that starts sideways and curls downwards keeps paging
 *     instead of flickering between the two.
 *
 * `null` means the finger has not moved far enough to have said anything yet.
 */
export function classifyDrag(input: {
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
}): DragIntent | null {
  const dx = Number.isFinite(input.dx) ? input.dx : 0;
  const dy = Number.isFinite(input.dy) ? input.dy : 0;
  if (Math.hypot(dx, dy) < DRAG_INTENT_THRESHOLD_PX) return null;
  if (Number.isFinite(input.scale) && input.scale > 1) return 'PAN';
  return Math.abs(dx) > Math.abs(dy) ? 'PAGE' : 'DISMISS';
}

/**
 * Which way a finished horizontal drag turns the page.
 *
 * Dragging LEFT (negative dx) pulls the next item in from the right, matching
 * every photo viewer on both phone platforms. `0` means the throw was too short
 * and the current item springs back.
 */
export function pageStepFromDrag(input: {
  readonly dx: number;
  readonly viewportWidth: number;
}): -1 | 0 | 1 {
  const dx = Number.isFinite(input.dx) ? input.dx : 0;
  const width = Number.isFinite(input.viewportWidth) ? input.viewportWidth : 0;
  // A zero-width viewport (measured before layout) must not make every twitch
  // commit a page turn, so an unmeasured viewport commits nothing.
  if (width <= 0) return 0;
  const threshold = width * PAGE_COMMIT_FRACTION;
  if (dx <= -threshold) return 1;
  if (dx >= threshold) return -1;
  return 0;
}

/**
 * Whether a finished vertical drag closes the viewer.
 *
 * Downward only. Dragging up is how people scroll, and closing on it would make
 * the viewer feel like it is snatching the gesture.
 */
export function shouldDismissFromDrag(input: { readonly dy: number }): boolean {
  return Number.isFinite(input.dy) && input.dy >= DISMISS_COMMIT_PX;
}

/**
 * How far apart two touch points are — the pinch measurement.
 *
 * Returns 0 for anything that is not exactly two touches, which lets the caller
 * treat "not a pinch" and "a pinch of no width" the same way: do nothing.
 */
export function touchDistance(
  points: readonly { readonly clientX: number; readonly clientY: number }[],
): number {
  if (points.length !== 2) return 0;
  const [a, b] = points as [
    { clientX: number; clientY: number },
    { clientX: number; clientY: number },
  ];
  const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  return Number.isFinite(distance) ? distance : 0;
}

/** The midpoint between two touches — where a pinch is anchored. */
export function touchMidpoint(
  points: readonly { readonly clientX: number; readonly clientY: number }[],
): { x: number; y: number } {
  if (points.length !== 2) return { x: 0, y: 0 };
  const [a, b] = points as [
    { clientX: number; clientY: number },
    { clientX: number; clientY: number },
  ];
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}
