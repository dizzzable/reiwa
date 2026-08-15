/**
 * AppBackground
 * ─────────────
 * Site-wide background rendered BEHIND the whole cabinet, driven by the
 * operator's `branding.appBackground`. A `kind` discriminator selects:
 *   - `none`     → nothing HERE, because the built-in `<NetworkBg>` is drawn
 *     instead by `StealthLayout`; this component is not even mounted for it.
 *     `none` is the default and it is a real picture (brand glows + dot grid +
 *     diagonals), not a blank colour — see `AppBackgroundKind`.
 *   - `plain`    → nothing at all: the flat `--brand-bg-primary` colour shows.
 *     This is the mode that means "no background artwork".
 *   - `gradient` → a static CSS gradient (free, no flicker).
 *   - `texture`  → a static, tiled SVG pattern over a base colour (free).
 *   - `effect`   → an animated ReactBits effect via `CardEffectLayer`.
 *
 * Mounted exactly once at the cabinet shell, so the animated mode costs at most
 * ONE live WebGL context; the static modes cost nothing. Decorative +
 * `aria-hidden`, sits at the back of the stacking context.
 *
 * This file does NOT govern the effect's resolution. It used to: the layer was
 * laid out at `scale × 100%` and stretched back with `transform: scale(1/scale)`
 * so that layout-measuring renderers would allocate smaller buffers. That
 * shrank the CSS box every effect derives its FEATURES from, so a `waves`
 * lattice pitch went 10 px → 33 px and `dither`'s `pixelSize: 2` looked like
 * 6.7 — a different picture, which breaks the rule that an effect renders the
 * same way here as in the Rezeis preview. It was also inert for the 20 effects
 * that size from `getBoundingClientRect()` (transformed geometry), and it
 * clipped `prismGrid` outright. The replacement caps the BACKING STORE inside
 * each effect instead — `@/components/reactbits/render-scale`.
 */

import { useLayoutEffect, useMemo } from "react";

import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { buildTextureCss } from "@/lib/app-texture";
import { resolveAppBackgroundReadability } from "@/lib/app-background-contrast";
import { clearBootstrapAppBackground } from "@/lib/branding-document";
import { useBranding } from "@/lib/branding-provider";
import { resolveAppBackgroundKind } from "@/types/branding";

export function AppBackground() {
  const { branding } = useBranding();
  const appBg = branding.appBackground;
  // A kind this build does not know resolves to `none`, i.e. "the built-in
  // background", which `StealthLayout` draws instead of mounting this. So
  // reaching the paint paths below with an unrecognised kind is impossible, and
  // the early `none` return keeps it that way if this is ever mounted directly.
  const kind = resolveAppBackgroundKind(appBg?.kind);
  // StealthLayout rerenders on every route change. The readability resolver
  // samples the full concept palette and is intentionally expensive, so only
  // recompute it when the operator's branding actually changes.
  const readability = useMemo(
    () => resolveAppBackgroundReadability(branding),
    [branding],
  );

  useLayoutEffect(() => {
    if (!appBg || kind === "none" || kind === "plain") return;
    // The static bootstrap layer remains visible through session loading and
    // is removed only after this equivalent React layer exists in the DOM.
    clearBootstrapAppBackground();
  }, [appBg, kind]);

  if (!appBg || kind === "none" || kind === "plain") return null;

  if (kind === "gradient") {
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

  if (kind === "texture") {
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
    <div
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      aria-hidden
    >
      {/* Keep the exact cold-boot gradient as the permanent base. The lazy
          shader fades in over it, so loading/probing/GPU failure never reveals
          the plain brand colour between frames. */}
      <div
        className="absolute inset-0"
        style={{ background: appBg.gradient }}
      />
      {/* The full-screen mount costs what the whole viewport costs, and that is
          handled INSIDE the effects, not here: each one caps its own drawing
          buffer through `resolveRenderScale` (see
          `@/components/reactbits/render-scale`), which reduces sampling density
          and leaves the CSS box — and therefore every feature size and count
          the operator configured — exactly as it is. Nothing in this file may
          resize or transform the layer to influence that: an effect must render
          the same way in the live cabinet as it does in the Rezeis preview, and
          the only way to keep that true is to leave its CSS geometry alone. */}
      {/* WHAT WENT WRONG: the layer started unmounting itself whenever the
          page was hidden, which is right for a card and wrong here. This one
          is mounted once for the whole cabinet, so a Telegram app-switch
          destroyed the only background context and recompiled its shader on
          return — a visible flash of the flat base gradient below, several
          times a session. There is no context contention to relieve (one
          layer, one context) and nothing to see if its clock lurches, since
          it sits behind the entire UI.

          WHAT THAT COST, AND WHERE IT IS PAID. Staying mounted means this is
          the one layer whose context can be lost while nobody is looking, and
          the recovery grace window used to be a plain timer: a hidden tab
          froze it, and the browser delivered it expired the moment the user
          came back — reporting a permanent failure precisely when the context
          was about to be restored, which left the cabinet background in the
          CSS fallback for the rest of the session. The window now pauses while
          the page is hidden (`observeCardEffectCanvases`), so keeping this
          mounted no longer trades a flash for a dead background. Do not
          "simplify" that timer back into a deadline. */}
      <CardEffectLayer
        effect={appBg.effect}
        props={appBg.props}
        opacity={appBg.opacity}
        active
        keepMountedWhileHidden
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
