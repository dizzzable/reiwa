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

import { useLayoutEffect } from "react";

import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { buildTextureCss } from "@/lib/app-texture";
import { resolveAppBackgroundReadability } from "@/lib/app-background-contrast";
import { clearBootstrapAppBackground } from "@/lib/branding-document";
import { useBranding } from "@/lib/branding-provider";

export function AppBackground() {
  const { branding } = useBranding();
  const appBg = branding.appBackground;
  const readability = resolveAppBackgroundReadability(branding);

  useLayoutEffect(() => {
    if (!appBg || appBg.kind === "none") return;
    // The static bootstrap layer remains visible through session loading and
    // is removed only after this equivalent React layer exists in the DOM.
    clearBootstrapAppBackground();
  }, [appBg]);

  if (!appBg || appBg.kind === "none") return null;

  if (appBg.kind === "gradient") {
    const texture = appBg.texture;
    const conceptTexture =
      typeof branding.themePresetId === "string" &&
      branding.themePresetId.startsWith("concept-") &&
      texture
        ? buildTextureCss(texture)
        : null;
    return (
      <div
        className="pointer-events-none absolute inset-0 z-0 isolate overflow-hidden"
        aria-hidden
        data-app-background-kind="gradient"
      >
        <div
          className="absolute inset-0"
          style={{ background: appBg.gradient }}
        />
        {conceptTexture && (
          <div
            className="absolute inset-0 mix-blend-soft-light"
            data-app-background-concept-texture={texture?.pattern}
            style={{
              backgroundImage: conceptTexture.backgroundImage,
              backgroundSize: conceptTexture.backgroundSize,
              backgroundRepeat: "repeat",
            }}
          />
        )}
        {readability && (
          <div
            className="absolute inset-0"
            aria-hidden
            data-app-background-readability="wcag-direct-copy-zones"
            data-app-background-readability-opacity={readability.veilOpacity}
            style={{ background: readability.overlayBackground }}
          />
        )}
      </div>
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
      >
        {readability && (
          <div
            className="absolute inset-0"
            aria-hidden
            data-app-background-readability="wcag-direct-copy-zones"
            data-app-background-readability-opacity={readability.veilOpacity}
            style={{ background: readability.overlayBackground }}
          />
        )}
      </div>
    );
  }

  // kind === "effect" — animated WebGL layer (single context).
  if (appBg.effect === "NONE") return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      {/* Keep the exact cold-boot gradient as the permanent base. The lazy
          shader fades in over it, so loading/probing/GPU failure never reveals
          the plain brand colour between frames. */}
      <div
        className="absolute inset-0"
        style={{ background: appBg.gradient }}
      />
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
