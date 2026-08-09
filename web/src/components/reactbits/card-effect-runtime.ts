/**
 * Runtime policy for branded card effects.
 *
 * Rezeis lets an operator select several GPU-backed effects. They are visual
 * enhancements, never a prerequisite for a readable subscription card: the CSS
 * card gradient is always present underneath. What each effect needs from the
 * device is declared beside the effect itself in `card-effect-catalog.ts`; this
 * file decides what to do when the device cannot supply it.
 */

import {
  cardEffectPalette,
  hasFullOutputGamut,
  requiresWebGL,
  requiresWebGL2,
} from "./card-effect-catalog";

// Re-exported because the layer has always asked this module, not the catalog,
// what a device must provide. Keeping the question where it was answered before
// leaves the split an implementation detail rather than a call-site migration.
export { requiresWebGL, requiresWebGL2 };

export interface CardEffectCapabilities {
  readonly webgl: boolean;
  readonly webgl2: boolean;
}

const NO_WEBGL_CAPABILITIES: CardEffectCapabilities = {
  webgl: false,
  webgl2: false,
};

export type CardEffectRuntimeMode =
  | "native"
  | "css-fallback";

export interface ResolvedCardEffectRuntime {
  readonly effect: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly mode: CardEffectRuntimeMode;
  readonly cssColors: readonly string[];
}

// Which effects need WebGL2, which draw on a plain canvas, which palette each
// falls back to, and which escape their input gamut: all of it now comes from
// the catalog, where it is stated once alongside the effect it describes. The
// four hand-kept sets that used to sit here are exactly what this file existed
// to keep in step, and exactly what kept slipping.

/**
 * Recognisable CSS colour forms only.
 *
 * This used to accept any non-empty string, which was safe while callers only
 * handed it props named `color…`. Now that every prop is inspected, "any
 * non-empty string" would read `shape: 'checks'`, `charset: 'dense'` and the
 * word a globe spells as colours — and those values also flow on to the CSS
 * fallback gradient, where they would produce an unparseable rule and a blank
 * layer. Bare colour keywords are deliberately not accepted beyond
 * `transparent`: telling `white` from `checks` needs the full keyword table,
 * and none of the effects' own defaults use one.
 */
const CSS_COLOR = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([^()]*\)|transparent)$/i;

function asColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CSS_COLOR.test(trimmed) ? trimmed : null;
}

function rgbVectorColor(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (channel) => typeof channel !== "number" || !Number.isFinite(channel),
    )
  ) {
    return null;
  }
  const scale = value.every((channel) => channel >= 0 && channel <= 1)
    ? 255
    : 1;
  return `#${value
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel * scale)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function configuredColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): string[] {
  const fromArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map(asColor).filter((value): value is string => value !== null)
      : [];

  /**
   * Every prop is inspected, rather than a fixed list of prop names.
   *
   * The list used to be thirteen hand-written keys, and the effects that have
   * arrived since do not use those names: `background`, `bgColor`, `voidColor`,
   * `strokeColor`, `particleColor`, `sparkColor`, `horizonColor`, `snakeColor`,
   * `anchor`, `colorA`… A missing name is not a harmless omission here, because
   * a PARTIAL match is worse than none: `resolveCardEffectColors` treats any
   * non-empty result as authoritative and stops falling back to the palette, so
   * the colours it did recognise become the whole picture.
   *
   * Black Hole is the case that showed it. Its marks are three whites and its
   * field is `background: '#000000'`; only the marks were recognised, contrast
   * concluded the card was white, and chose dark text — over a card the
   * component then painted black. The panel's own preview never reproduced it,
   * because that one already scans every value. Scanning here is what makes the
   * operator's preview and the subscriber's card agree.
   */
  const colors = Object.values(props).flatMap((value) => {
    const single = asColor(value) ?? rgbVectorColor(value);
    if (single !== null) return [single];
    return fromArray(value);
  });

  if (effect === "rippleGrid" && props["enableRainbow"] === true) {
    colors.push(
      "#ff0000",
      "#ffff00",
      "#00ff00",
      "#00ffff",
      "#0000ff",
      "#ff00ff",
    );
  }
  if (effect === "dither") colors.push("#000000");
  if (effect === "liquidChrome") colors.push("#000000", "#ffffff");
  if (effect === "galaxy") {
    const hue =
      typeof props["hueShift"] === "number" &&
      Number.isFinite(props["hueShift"])
        ? props["hueShift"]
        : 140;
    const saturation =
      typeof props["saturation"] === "number" &&
      Number.isFinite(props["saturation"])
        ? Math.min(1, Math.max(0, props["saturation"]))
        : 0;
    if (saturation > 0) {
      colors.push(
        `hsl(${hue} ${Math.round(saturation * 100)}% 60%)`,
      );
    }
    colors.push("#ffffff", "#000000");
  }
  if (["radar", "plasma", "beams"].includes(effect)) {
    colors.push("#000000");
  }

  return [...new Set(colors)];
}

export function resolveCardEffectColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const configured = configuredColors(effect, props);
  return configured.length > 0 ? configured : cardEffectPalette(effect);
}

/**
 * Conservative fragment colours used only for contrast analysis.
 *
 * Keep this separate from `resolveCardEffectColors`: the latter also powers
 * the static CSS fallback and must stay faithful to the branded input palette.
 */
export function resolveCardEffectOutputColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const colors = [...resolveCardEffectColors(effect, props)];
  // A shader whose output leaves its input palette — glow, additive channels,
  // procedural noise — can put either display extreme behind the card text, so
  // contrast has to be judged against both.
  if (hasFullOutputGamut(effect)) {
    colors.push("#000000", "#ffffff");
  }
  return [...new Set(colors)];
}

/**
 * WebGL availability is intentionally probed only when an effect is about to
 * mount. Creating a probe for every off-screen carousel slide would itself
 * exhaust iOS's small live-context budget.
 */
export function detectCardEffectCapabilities(): CardEffectCapabilities {
  if (typeof document === "undefined") return NO_WEBGL_CAPABILITIES;

  const probe = (kind: "webgl" | "webgl2"): boolean => {
    const canvas = document.createElement("canvas");
    try {
      const context = canvas.getContext(kind, {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "low-power",
      });
      if (context === null || !("getExtension" in context)) return false;
      const loseContext = context.getExtension("WEBGL_lose_context") as
        | { loseContext?: () => void }
        | null;
      loseContext?.loseContext?.();
      return true;
    } catch {
      return false;
    }
  };

  const webgl2 = probe("webgl2");
  return { webgl2, webgl: webgl2 || probe("webgl") };
}

function resolveCssFallback(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): ResolvedCardEffectRuntime {
  return {
    effect: "NONE",
    props: {},
    mode: "css-fallback",
    cssColors: resolveCardEffectColors(effect, props),
  };
}

/**
 * Resolves the active effect without looking at the user agent. A context can
 * disappear under GPU pressure on any browser, so feature availability is the
 * only reliable input. An unavailable or failed renderer always becomes a
 * same-palette CSS fallback; it must never substitute another live effect.
 */
export function resolveCardEffectRuntime({
  effect,
  props,
  capabilities,
  failed = false,
  failureCount = 0,
}: {
  readonly effect: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly capabilities: CardEffectCapabilities;
  /** @deprecated Prefer `failureCount` for runtime failure state. */
  readonly failed?: boolean;
  readonly failureCount?: number;
}): ResolvedCardEffectRuntime {
  const runtimeFailureCount = Math.max(failureCount, failed ? 1 : 0);

  if (effect === "NONE") {
    return {
      effect: "NONE",
      props: {},
      mode: "native",
      cssColors: [],
    };
  }

  if (!requiresWebGL(effect)) {
    return runtimeFailureCount > 0
      ? resolveCssFallback(effect, props)
      : {
          effect,
          props,
          mode: "native",
          cssColors: [],
        };
  }

  const unavailable =
    !capabilities.webgl ||
    (requiresWebGL2(effect) && !capabilities.webgl2);

  if (!unavailable && runtimeFailureCount === 0) {
    return {
      effect,
      props,
      mode: "native",
      cssColors: [],
    };
  }

  // WebGL2-only shaders cannot start on a WebGL1-only Telegram WebView, and a
  // lost context cannot safely be retried. Preserve the selected artwork's
  // palette in CSS instead of replacing it with another animation.
  return resolveCssFallback(effect, props);
}
