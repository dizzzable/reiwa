/**
 * AppBackground
 * ─────────────
 * Site-wide background rendered BEHIND the whole cabinet, driven by the
 * operator's `branding.appBackground`. A `kind` discriminator selects:
 *   - `none`     → nothing (the plain `--brand-bg-primary` colour shows).
 *   - `gradient` → a static CSS gradient (free, no flicker).
 *   - `texture`  → a static, tiled SVG pattern over a base colour (free).
 *   - `effect`   → an animated ReactBits effect via `CardEffectLayer`.
 *
 * Mounted exactly once at the cabinet shell, so the animated mode costs at most
 * ONE live WebGL context; the static modes cost nothing. Decorative +
 * `aria-hidden`, sits at the back of the stacking context.
 */

import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { buildTextureCss } from "@/lib/app-texture";
import { useBranding } from "@/lib/branding-provider";

export function AppBackground() {
  const { branding } = useBranding();
  const appBg = branding.appBackground;
  if (!appBg || appBg.kind === "none") return null;

  if (appBg.kind === "gradient") {
    return (
      <div
        className="pointer-events-none absolute inset-0 z-0"
        aria-hidden
        style={{ background: appBg.gradient }}
      />
    );
  }

  if (appBg.kind === "texture") {
    const css = buildTextureCss(appBg.texture);
    return (
      <div
        className="pointer-events-none absolute inset-0 z-0"
        aria-hidden
        style={{
          backgroundColor: css.backgroundColor,
          backgroundImage: css.backgroundImage,
          backgroundSize: css.backgroundSize,
          backgroundRepeat: "repeat",
        }}
      />
    );
  }

  // kind === "effect" — animated WebGL layer (single context).
  if (appBg.effect === "NONE") return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      <CardEffectLayer
        effect={appBg.effect}
        props={appBg.props}
        opacity={appBg.opacity}
        active
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
