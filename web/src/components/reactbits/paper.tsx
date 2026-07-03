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
  type SwirlProps,
  type WarpProps,
} from "@paper-design/shaders-react";

const FILL = { width: "100%", height: "100%" } as const;

export function PaperMesh(props: Record<string, unknown>) {
  return <MeshGradient {...(props as unknown as MeshGradientProps)} style={FILL} />;
}

export function PaperWarp(props: Record<string, unknown>) {
  return <Warp {...(props as unknown as WarpProps)} style={FILL} />;
}

export function PaperGrain(props: Record<string, unknown>) {
  return <GrainGradient {...(props as unknown as GrainGradientProps)} style={FILL} />;
}

export function PaperDither(props: Record<string, unknown>) {
  return <Dithering {...(props as unknown as DitheringProps)} style={FILL} />;
}

export function PaperSwirl(props: Record<string, unknown>) {
  return <Swirl {...(props as unknown as SwirlProps)} style={FILL} />;
}

export function PaperMetaballs(props: Record<string, unknown>) {
  return <Metaballs {...(props as unknown as MetaballsProps)} style={FILL} />;
}
