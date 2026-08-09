/**
 * The device-pixel budget, wired into a React Three Fiber canvas.
 * ──────────────────────────────────────────────────────────────
 * Three effects (beams, silk, dither) are fiber-backed, and fiber owns both
 * halves of the thing being capped: it measures the CSS box, writes
 * `canvas.style.width/height` from that measurement, and multiplies ONLY the
 * drawing buffer by `viewport.dpr`. So lowering the ratio is exactly MDN's
 * smaller-back-buffer mitigation, with the CSS presentation size held constant
 * — nothing here touches layout.
 *
 * WHY IT IS NOT JUST `setDpr()` FROM AN EFFECT. fiber re-applies the `dpr` PROP
 * on every render of `<Canvas>`: `if (dpr && viewport.dpr !== calculateDpr(dpr))
 * setDpr(dpr)`. A component that lowered the ratio from inside would have it
 * silently restored by the next re-render — an operator dragging a slider
 * re-renders per frame — and the cap would be undone with nothing to see. So
 * the resolved number is lifted OUT to the `dpr` prop itself: fiber then finds
 * the prop and the store already in agreement and leaves them alone.
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

import { resolveRenderScale } from './render-scale';

/** What fiber accepts as a `dpr` prop: a fixed ratio or a `[min, max]` clamp. */
export type FiberDpr = number | [number, number];

/**
 * fiber's own `calculateDpr`, reproduced so the FIRST frame is budgeted from
 * the same number fiber would have used — importing it is not an option, it is
 * module-private. `?? 2` mirrors fiber's "err on the side of progress" default
 * for workers, where `window` exists but the ratio does not.
 */
function calculateDpr(dpr: FiberDpr): number {
  const target = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 2) : 1;
  return Array.isArray(dpr) ? Math.min(Math.max(dpr[0], target), dpr[1]) : dpr;
}

export interface BudgetedDprProps {
  /** The ratio this canvas would use without a budget. */
  readonly base: FiberDpr;
  /**
   * Called with the ratio to put on the `dpr` prop, and the factor it was
   * reduced by. Anything denominated in BUFFER pixels — dither's `pixelSize` —
   * must be multiplied by `scale` to keep the size it has on screen.
   *
   * Must be referentially stable (`useCallback`) and must not set state
   * unconditionally, or this re-renders forever.
   */
  readonly onResolve: (dpr: number, scale: number) => void;
}

/**
 * Renders nothing; exists to read the size fiber measured.
 *
 * `size` is the CSS box — the same one fiber writes back into `canvas.style` —
 * so the budget is computed against presentation pixels, which is what it is
 * denominated in.
 */
export function BudgetedDpr({ base, onResolve }: BudgetedDprProps): null {
  const width = useThree(state => state.size.width);
  const height = useThree(state => state.size.height);
  // Resolved during render rather than inside the effect so the effect can
  // depend on the NUMBER: `base` is a tuple literal at every call site, and a
  // reference comparison on it would re-run this on every render.
  const baseDpr = calculateDpr(base);

  useEffect(() => {
    const scale = resolveRenderScale(width, height, baseDpr);
    onResolve(baseDpr * scale, scale);
  }, [baseDpr, height, onResolve, width]);

  return null;
}
