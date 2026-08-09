/**
 * Paper Shaders wrappers (reiwa SPA).
 * ──────────────────────────────────
 * Thin adapters around @paper-design/shaders-react so each shader fills its
 * container (the `CardEffectLayer` / `AppBackground` absolute-inset box) and
 * plugs into our effect registry, which types components as
 * `ComponentType<Record<string, unknown>>`.
 *
 * Paper components are WebGL2, zero-dependency, and accept plain <div> props
 * plus their shader params — so we just forward the registry props and force
 * a 100%×100% size. Each is code-split via the registry's `lazy()` import.
 *
 * Apache-2.0 (Lost Coast Labs / paper.design); license ships in node_modules.
 */

import { useLayoutEffect, useRef } from "react";
import {
  Dithering,
  GrainGradient,
  MeshGradient,
  Metaballs,
  Swirl,
  Warp,
  type DitheringProps,
  type GrainGradientProps,
  type MeshGradientProps,
  type MetaballsProps,
  type PaperShaderElement,
  type SwirlProps,
  type WarpProps,
} from "@paper-design/shaders-react";

import { RENDER_PIXEL_BUDGET } from "./render-scale";

const FILL = { width: "100%", height: "100%" } as const;

/**
 * Hard ceiling on Paper's drawing buffer, in device pixels.
 *
 * It is `RENDER_PIXEL_BUDGET` — the SAME number and the same rationale the
 * other forty-eight effects are capped by, deliberately imported rather than
 * restated. This file used to carry its own `1920 * 1080` with its own
 * argument for it; two constants that happened to agree is one refactor away
 * from two constants that do not, and the whole point of a budget is that a
 * mount costs the same whichever effect an operator picks.
 *
 * Why Paper needs a cap at all: `ShaderMount` renders at
 * `max(devicePixelRatio, minPixelRatio = 2)` — NATIVE DPR on every phone,
 * uncapped — and the package's own default `maxPixelCount` of 8,294,400 (4K)
 * starts binding only beyond 4K. So a DPR-3 phone shades 3.01M device pixels
 * per frame (393×852×3²) where the rest of the catalog is capped at 2.07M.
 *
 * Paper implements the cap itself, and implements it the right way: past the
 * ceiling it shrinks the back buffer and stretches it over the UNCHANGED CSS
 * box (`scaleToMeetMaxPixelCount` in `@paper-design/shaders`) — MDN's own
 * smaller-back-buffer mitigation, and exactly what `render-scale.ts` does for
 * everything else. So these six effects need the number and nothing more.
 *
 * Passed AFTER the registry-props spread so operator-authored JSON can never
 * raise it. `minPixelRatio` stays at the package default deliberately: it
 * governs sharpness on low-DPR screens, not the ceiling.
 */
const PAPER_MAX_PIXEL_COUNT = RENDER_PIXEL_BUDGET;

/**
 * Release the WebGL context Paper owns.
 *
 * The renderer is inside the package: `ShaderMount` creates its own canvas and
 * calls `getContext('webgl2')` on it. Its `dispose()` does delete the program
 * and textures, disconnect its observers and remove the canvas — but it never
 * calls `WEBGL_lose_context.loseContext()`. Dropping the reference does not
 * return the slot; WebKit only frees one when the context object is destroyed,
 * and it caps a web-content process at 16 live contexts before it starts
 * recycling the oldest and handing out an unrecoverable SyntheticLostContext.
 * Six effects come out of this file, so a carousel reached that cap on its own.
 *
 * Reaching it from outside works because the parent <div> Paper renders is a
 * `PaperShaderElement`, which carries the mount, and `canvasElement` is public.
 * We call the package's own `dispose()` first so the GPU objects go before the
 * context does, then lose the context. Paper's own cleanup calls `dispose()`
 * again a moment later, which is a no-op by then.
 *
 * WHAT WENT WRONG: all of that ran from a `useEffect` cleanup that read
 * `elementRef.current` — and by then the ref is `null`, so the entire release
 * was a silent no-op and the contexts went on leaking exactly as before. When
 * React deletes a subtree it detaches refs during the MUTATION phase, while
 * passive cleanups for that subtree are deferred and flushed after paint. The
 * ref is therefore always cleared first.
 *
 * Two changes, either of which would be enough, kept together deliberately:
 * the cleanup is a LAYOUT effect, which for a deletion runs parent-first inside
 * the mutation phase and therefore before React reaches the host element that
 * holds the ref; and the element is captured into a local on mount, so the
 * cleanup closes over it and never has to consult a ref at all.
 *
 * Because either alone suffices, neither is visible in "does the release run" —
 * which is all the tests used to ask, so both could be reverted one at a time
 * and stay green. `web/test/paper-context-release.test.tsx` now pins them
 * separately: the layout half by WHEN the release runs (the element is still in
 * the document), the capture half by making it run against an emptied ref.
 */
function usePaperContextRelease() {
  const elementRef = useRef<PaperShaderElement | null>(null);

  useLayoutEffect(() => {
    // Refs are attached during the mutation phase, before layout effects run,
    // so this is the element — not `null` and not a stale one. `paperShaderMount`
    // is NOT read here: Paper creates it later, from its own passive effect.
    const mountedElement = elementRef.current;

    return () => {
      const element = mountedElement ?? elementRef.current;
      if (element === null) return;
      const mount = element.paperShaderMount;
      const canvas = mount?.canvasElement ?? element.querySelector("canvas");
      mount?.dispose();
      canvas
        ?.getContext("webgl2")
        ?.getExtension("WEBGL_lose_context")
        ?.loseContext();
    };
  }, []);

  return elementRef;
}

export function PaperMesh(props: Record<string, unknown>) {
  const ref = usePaperContextRelease();
  return (
    <MeshGradient
      {...(props as unknown as MeshGradientProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  );
}

export function PaperWarp(props: Record<string, unknown>) {
  const ref = usePaperContextRelease();
  return (
    <Warp
      {...(props as unknown as WarpProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  );
}

export function PaperGrain(props: Record<string, unknown>) {
  const ref = usePaperContextRelease();
  return (
    <GrainGradient
      {...(props as unknown as GrainGradientProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  );
}

export function PaperDither(props: Record<string, unknown>) {
  const ref = usePaperContextRelease();
  return (
    <Dithering
      {...(props as unknown as DitheringProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  );
}

export function PaperSwirl(props: Record<string, unknown>) {
  const ref = usePaperContextRelease();
  return (
    <Swirl
      {...(props as unknown as SwirlProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  );
}

export function PaperMetaballs(props: Record<string, unknown>) {
  const ref = usePaperContextRelease();
  return (
    <Metaballs
      {...(props as unknown as MetaballsProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  );
}
