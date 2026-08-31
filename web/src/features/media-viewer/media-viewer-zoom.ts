/**
 * Zoom and pan state for one image in the media viewer.
 *
 * Pure on purpose. Everything here is arithmetic over a viewport and a rendered
 * image, and it is the part of a viewer that goes subtly wrong — an image that
 * drifts off screen, a pinch that walks away from the fingers, a zoom that
 * survives into the next picture. Keeping it out of the component means those
 * can be pinned by tests instead of by looking at a phone.
 *
 * Coordinates: `x`/`y` are the offset of the image centre from the viewport
 * centre, in CSS pixels, AFTER scaling. Positive x moves the image right.
 */

export interface ZoomState {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The image as laid out at scale 1 (already fitted inside the viewport by
 * `object-contain`), plus the viewport it sits in.
 */
export interface ZoomBounds {
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 };

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;

/**
 * Where a double tap lands.
 *
 * 2.5 rather than MAX_SCALE: the gesture exists to make the small text on a
 * support screenshot readable in one tap, and jumping straight to 4 overshoots
 * far enough that the next thing a person does is pinch back out.
 */
export const DOUBLE_TAP_SCALE = 2.5;

const isFinitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * How far the image may travel before its edge would enter the viewport.
 *
 * Zero on an axis the scaled image does not overflow — a portrait screenshot
 * zoomed 2× may be pannable vertically and pinned horizontally, and pinning is
 * what keeps it centred instead of sliding into a corner.
 */
export function maxOffset(bounds: ZoomBounds, scale: number): { x: number; y: number } {
  if (!isFinitePositive(scale)) return { x: 0, y: 0 };
  const overflow = (content: number, viewport: number): number => {
    if (!Number.isFinite(content) || !Number.isFinite(viewport)) return 0;
    return Math.max(0, (content * scale - viewport) / 2);
  };
  return {
    x: overflow(bounds.contentWidth, bounds.viewportWidth),
    y: overflow(bounds.contentHeight, bounds.viewportHeight),
  };
}

const clampTo = (value: number, limit: number): number =>
  Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : 0;

/** Forces a state back inside the scale range and the pan limits. */
export function clampZoom(state: ZoomState, bounds: ZoomBounds): ZoomState {
  const scale = Number.isFinite(state.scale)
    ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale))
    : MIN_SCALE;
  // At rest the image is centred, full stop. Letting a leftover offset survive
  // a zoom-out is how a picture ends up sitting off to one side with no way to
  // put it back short of closing the viewer.
  if (scale === MIN_SCALE) return { scale, x: 0, y: 0 };
  const limit = maxOffset(bounds, scale);
  return { scale, x: clampTo(state.x, limit.x), y: clampTo(state.y, limit.y) };
}

/**
 * Zooms to `targetScale` while keeping the point of the image under `focus`
 * under `focus`.
 *
 * `focus` is in viewport coordinates relative to the viewport CENTRE, which is
 * what makes this a two-line calculation: the content point under the focus is
 * `(focus - offset) / scale`, and holding it still across the change gives the
 * offset below. Without this a pinch drifts away from the fingers, and a double
 * tap magnifies the middle of the picture rather than the thing that was tapped.
 */
export function zoomTo(
  state: ZoomState,
  targetScale: number,
  focus: { readonly x: number; readonly y: number },
  bounds: ZoomBounds,
): ZoomState {
  const from = Number.isFinite(state.scale) ? state.scale : MIN_SCALE;
  const to = Number.isFinite(targetScale)
    ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetScale))
    : MIN_SCALE;
  const ratio = to / from;
  const fx = Number.isFinite(focus.x) ? focus.x : 0;
  const fy = Number.isFinite(focus.y) ? focus.y : 0;
  return clampZoom(
    { scale: to, x: fx - (fx - state.x) * ratio, y: fy - (fy - state.y) * ratio },
    bounds,
  );
}

/** Double tap: out to fit if already magnified, otherwise in on the tapped point. */
export function toggleZoom(
  state: ZoomState,
  focus: { readonly x: number; readonly y: number },
  bounds: ZoomBounds,
): ZoomState {
  return state.scale > MIN_SCALE
    ? NO_ZOOM
    : zoomTo(state, DOUBLE_TAP_SCALE, focus, bounds);
}

/** Drag while magnified. */
export function panBy(
  state: ZoomState,
  dx: number,
  dy: number,
  bounds: ZoomBounds,
): ZoomState {
  return clampZoom(
    {
      scale: state.scale,
      x: state.x + (Number.isFinite(dx) ? dx : 0),
      y: state.y + (Number.isFinite(dy) ? dy : 0),
    },
    bounds,
  );
}

/** Whether this state shows the image magnified rather than merely fitted. */
export function isZoomed(state: ZoomState): boolean {
  return state.scale > MIN_SCALE;
}
