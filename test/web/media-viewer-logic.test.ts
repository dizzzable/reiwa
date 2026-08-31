import { describe, expect, it } from 'vitest';

import {
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  NO_ZOOM,
  clampZoom,
  isZoomed,
  maxOffset,
  panBy,
  toggleZoom,
  zoomTo,
} from '../../web/src/features/media-viewer/media-viewer-zoom.js';
import {
  DISMISS_COMMIT_PX,
  classifyDrag,
  pageStepFromDrag,
  shouldDismissFromDrag,
  touchDistance,
  touchMidpoint,
} from '../../web/src/features/media-viewer/media-viewer-gestures.js';
import {
  canStep,
  clampIndex,
  stepIndex,
} from '../../web/src/features/media-viewer/media-viewer-nav.js';

/** A portrait screenshot letterboxed into a phone viewport. */
const bounds = {
  contentWidth: 300,
  contentHeight: 600,
  viewportWidth: 400,
  viewportHeight: 700,
};

describe('maxOffset', () => {
  it('pins an axis the scaled image does not overflow', () => {
    // 300 × 2 = 600 wide in a 400 viewport → 100 each side.
    // 600 × 2 = 1200 tall in a 700 viewport → 250 each side.
    expect(maxOffset(bounds, 2)).toEqual({ x: 100, y: 250 });
  });

  it('allows no travel at all while the image merely fits', () => {
    expect(maxOffset(bounds, 1)).toEqual({ x: 0, y: 0 });
  });

  it('survives an image that has not been measured yet', () => {
    const unmeasured = { ...bounds, contentWidth: 0, contentHeight: 0 };
    expect(maxOffset(unmeasured, 3)).toEqual({ x: 0, y: 0 });
    expect(maxOffset(bounds, Number.NaN)).toEqual({ x: 0, y: 0 });
  });
});

describe('clampZoom', () => {
  it('recentres the image whenever it is back to fitting', () => {
    // The bug this prevents: zoom in, drag to a corner, zoom out — and the
    // picture stays parked off to one side with no gesture left to fix it.
    expect(clampZoom({ scale: 1, x: -80, y: 40 }, bounds)).toEqual(NO_ZOOM);
  });

  it('keeps the image edge from entering the viewport', () => {
    expect(clampZoom({ scale: 2, x: 999, y: -999 }, bounds)).toEqual({
      scale: 2,
      x: 100,
      y: -250,
    });
  });

  it('holds the scale inside its range', () => {
    expect(clampZoom({ scale: 99, x: 0, y: 0 }, bounds).scale).toBe(MAX_SCALE);
    expect(clampZoom({ scale: 0.2, x: 0, y: 0 }, bounds)).toEqual(NO_ZOOM);
    expect(clampZoom({ scale: Number.NaN, x: 0, y: 0 }, bounds)).toEqual(NO_ZOOM);
  });
});

describe('zoomTo', () => {
  it('holds the focused point still', () => {
    // Focus 50px right of centre, zooming 1 → 2. The content point under the
    // focus was at (50 - 0)/1 = 50; after the zoom it must still sit under 50,
    // so the offset moves to 50 - 50×2 = -50.
    const next = zoomTo(NO_ZOOM, 2, { x: 50, y: 0 }, bounds);
    expect(next.scale).toBe(2);
    expect(next.x).toBe(-50);
  });

  it('does not let the anchoring push the image off its own edge', () => {
    // Focus at the far corner would want an offset past the pan limit; the
    // clamp wins, otherwise a pinch in the corner shows empty space.
    const next = zoomTo(NO_ZOOM, 2, { x: 200, y: 350 }, bounds);
    expect(Math.abs(next.x)).toBeLessThanOrEqual(100);
    expect(Math.abs(next.y)).toBeLessThanOrEqual(250);
  });

  it('treats a nonsense focus as the centre rather than producing NaN', () => {
    const next = zoomTo(NO_ZOOM, 2, { x: Number.NaN, y: Number.NaN }, bounds);
    expect(next).toEqual({ scale: 2, x: 0, y: 0 });
  });
});

describe('toggleZoom', () => {
  it('magnifies the tapped point on the way in', () => {
    const next = toggleZoom(NO_ZOOM, { x: 40, y: 0 }, bounds);
    expect(next.scale).toBe(DOUBLE_TAP_SCALE);
    expect(next.x).not.toBe(0);
  });

  it('returns all the way to fitted on the way out, wherever it was panned', () => {
    expect(toggleZoom({ scale: 2.5, x: 90, y: -200 }, { x: 0, y: 0 }, bounds)).toEqual(NO_ZOOM);
  });
});

describe('panBy', () => {
  it('moves a magnified image and stops at its edge', () => {
    expect(panBy({ scale: 2, x: 0, y: 0 }, 40, -60, bounds)).toEqual({
      scale: 2,
      x: 40,
      y: -60,
    });
    expect(panBy({ scale: 2, x: 90, y: 0 }, 40, 0, bounds).x).toBe(100);
  });

  it('refuses to move an image that is merely fitted', () => {
    expect(panBy(NO_ZOOM, 60, 60, bounds)).toEqual(NO_ZOOM);
  });
});

describe('classifyDrag', () => {
  it('says nothing until the finger has actually moved', () => {
    expect(classifyDrag({ scale: 1, dx: 3, dy: 3 })).toBeNull();
  });

  it('gives every drag to panning while the image is magnified', () => {
    // Including a clean horizontal one. Reading a zoomed screenshot must never
    // turn the page just because the reader pushed past the left edge.
    expect(classifyDrag({ scale: 2, dx: -200, dy: 0 })).toBe('PAN');
    expect(classifyDrag({ scale: 2, dx: 0, dy: 200 })).toBe('PAN');
  });

  it('pages sideways and dismisses downwards when the image is fitted', () => {
    expect(classifyDrag({ scale: 1, dx: -40, dy: 10 })).toBe('PAGE');
    expect(classifyDrag({ scale: 1, dx: 10, dy: 40 })).toBe('DISMISS');
  });
});

describe('pageStepFromDrag', () => {
  it('pulls the next item in when dragged left', () => {
    expect(pageStepFromDrag({ dx: -150, viewportWidth: 400 })).toBe(1);
    expect(pageStepFromDrag({ dx: 150, viewportWidth: 400 })).toBe(-1);
  });

  it('springs back on a throw that was too short', () => {
    expect(pageStepFromDrag({ dx: -60, viewportWidth: 400 })).toBe(0);
  });

  it('commits nothing before the viewport has been measured', () => {
    // Otherwise every threshold is zero and the smallest twitch turns the page.
    expect(pageStepFromDrag({ dx: -2, viewportWidth: 0 })).toBe(0);
  });
});

describe('shouldDismissFromDrag', () => {
  it('closes on a downward throw only', () => {
    expect(shouldDismissFromDrag({ dy: DISMISS_COMMIT_PX })).toBe(true);
    expect(shouldDismissFromDrag({ dy: -300 })).toBe(false);
    expect(shouldDismissFromDrag({ dy: 40 })).toBe(false);
  });
});

describe('touch helpers', () => {
  it('measures a pinch', () => {
    expect(
      touchDistance([
        { clientX: 0, clientY: 0 },
        { clientX: 30, clientY: 40 },
      ]),
    ).toBe(50);
    expect(
      touchMidpoint([
        { clientX: 0, clientY: 0 },
        { clientX: 30, clientY: 40 },
      ]),
    ).toEqual({ x: 15, y: 20 });
  });

  it('reports nothing for anything that is not two fingers', () => {
    expect(touchDistance([{ clientX: 1, clientY: 1 }])).toBe(0);
    expect(touchDistance([])).toBe(0);
    expect(touchMidpoint([{ clientX: 1, clientY: 1 }])).toEqual({ x: 0, y: 0 });
  });
});

describe('navigation', () => {
  it('points at nothing when there is nothing to point at', () => {
    expect(clampIndex(0, 0)).toBe(-1);
    expect(stepIndex(0, 0, 1)).toBe(-1);
    expect(canStep(0, 0, 1)).toBe(false);
  });

  it('survives an index left over from a longer list', () => {
    expect(clampIndex(7, 3)).toBe(2);
  });

  it('stops at the ends instead of wrapping', () => {
    expect(stepIndex(2, 3, 1)).toBe(2);
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(canStep(2, 3, 1)).toBe(false);
    expect(canStep(1, 3, 1)).toBe(true);
  });
});

describe('isZoomed', () => {
  it('separates fitted from magnified', () => {
    expect(isZoomed(NO_ZOOM)).toBe(false);
    expect(isZoomed({ scale: 1.01, x: 0, y: 0 })).toBe(true);
  });
});
