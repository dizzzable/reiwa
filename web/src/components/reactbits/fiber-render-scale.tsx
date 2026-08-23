/**
 * The device-pixel budget, wired into a React Three Fiber canvas.
 * ──────────────────────────────────────────────────────────────
 * Four card effects (antigravity, beams, silk, dither) are fiber-backed, and
 * fiber owns both
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
import { useThree, type RootState } from '@react-three/fiber';
import type { Mesh, Object3D } from 'three';

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

/**
 * Delete the GPU objects hanging off a scene before the context that owns them
 * goes away. Losing the context frees the driver allocations but leaves every
 * three.js wrapper — geometry buffers, material programs — attached to the
 * renderer's internal maps.
 */
function releaseSceneResources(scene: Object3D): void {
  scene.traverse(object => {
    const mesh = object as Partial<Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
  });
}

/**
 * Hand a fiber root's WebGL context back to the driver — synchronously, and
 * exactly once.
 * ──────────────────────────────────────────────────────────────
 * WHY SYNCHRONOUSLY. fiber does release the context on unmount, but from
 * inside a 500 ms `setTimeout` and without ever calling `gl.dispose()`. Half a
 * second is several slides of a carousel swipe, and WebKit allows only 16 live
 * WebGL contexts per web-content process before it starts recycling the oldest
 * and handing out an unrecoverable SyntheticLostContext. So the slot goes back
 * while unmounting, not half a second later.
 *
 * WHY EXACTLY ONCE, AND WHY THE METHOD IS SPENT. fiber's `setTimeout` still
 * fires. Its body is `state.gl?.forceContextLoss?.()` against the context this
 * function has already destroyed, and `WEBGL_lose_context.loseContext()` on an
 * already-lost context is INVALID_OPERATION per the extension spec. That is
 * what shipped: two console lines per card, one `THREE.Clock` deprecation from
 * fiber's store on mount and one `loseContext: context already lost` on
 * unmount, every time a card crossed its IntersectionObserver gate.
 *
 * A flag the CALLERS consult cannot reach it. The second caller is fiber's own
 * module code reading its own store — it consults nothing of ours — so
 * replacing the method on the renderer is the only lever on that call site
 * short of patching the package. Its blast radius is the one instance this
 * line has just spent: three assigns `forceContextLoss` as an OWN property in
 * the `WebGLRenderer` constructor (`this.forceContextLoss = function () { … }`)
 * rather than on the prototype, so nothing is shadowed and no other canvas can
 * see it. A no-op rather than deleting the method, because
 * `WebGLRenderer.forceContextLoss` is typed non-optional: fiber's `?.()` would
 * skip an absent one, but any other caller would throw on it.
 *
 * THE GUARD LIVES HERE AND NOWHERE ELSE. Each caller still clears its own
 * `rootRef` before calling — that is what keeps a re-invoked effect cleanup
 * from arriving twice — and this is what keeps fiber's timer from arriving at
 * all. One invariant, one place: a second guard in the components is how the
 * ambiguity about who owns the release survives the next edit.
 */
export function releaseFiberRoot(root: RootState): void {
  releaseSceneResources(root.scene);
  // dispose() detaches THREE.WebGLRenderer's own webglcontextlost /
  // webglcontextrestored listeners, so the loss below cannot re-enter the
  // restore path and rebuild what we are freeing.
  root.gl.dispose();
  root.gl.forceContextLoss();
  root.gl.forceContextLoss = () => {};
}
