/**
 * AppBackground
 * ─────────────
 * Site-wide animated background rendered BEHIND the whole cabinet, driven by
 * the operator's `branding.appBackground` (effect id + props + opacity). Reuses
 * the shared card-effect registry via `CardEffectLayer`.
 *
 * Mounted exactly once at the cabinet shell, so it costs at most ONE live
 * WebGL context regardless of how many subscription cards are on screen
 * (mobile browsers cap WebGL contexts at ~8 — see the multi-card fix in
 * `subscription-carousel`). When `effect` is `NONE` it renders nothing and the
 * plain `--brand-bg-primary` colour shows through.
 *
 * Decorative + `aria-hidden`; sits at the back of the stacking context behind
 * the content column (`z-10`/`z-20`).
 */

import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { useBranding } from "@/lib/branding-provider";

export function AppBackground() {
  const { branding } = useBranding();
  const appBg = branding.appBackground;

  // Absent / NONE → no WebGL layer; the brand colour backdrop is enough.
  if (!appBg || appBg.effect === "NONE") return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      <CardEffectLayer
        effect={appBg.effect}
        props={appBg.props}
        opacity={appBg.opacity}
        // `active` drives mounting exclusively → a single, always-on context.
        active
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
