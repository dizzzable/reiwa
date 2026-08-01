/**
 * Runtime policy for branded card effects.
 *
 * Rezeis lets an operator select several GPU-backed effects. They are visual
 * enhancements, never a prerequisite for a readable subscription card: the
 * CSS card gradient is always present underneath. Paper effects need WebGL2;
 * most other live effects can run on WebGL1; `waves` is Canvas 2D.
 */

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
  | "webgl1-fallback"
  | "css-fallback";

export interface ResolvedCardEffectRuntime {
  readonly effect: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly mode: CardEffectRuntimeMode;
  readonly cssColors: readonly string[];
}

const PAPER_EFFECTS = new Set([
  "paperMesh",
  "paperWarp",
  "paperGrain",
  "paperDither",
  "paperSwirl",
  "paperMetaballs",
]);

// This effect deliberately uses Canvas 2D and is safe when WebGL is absent.
const CANVAS_2D_EFFECTS = new Set(["waves"]);

const DEFAULT_AURORA_COLORS = ["#5227FF", "#7CFF67", "#5227FF"] as const;
const DEFAULT_EFFECT_COLORS: Readonly<Record<string, readonly string[]>> = {
  aurora: DEFAULT_AURORA_COLORS,
  threads: ["#ffffff"],
  softAurora: ["#f7f7f7", "#e100ff"],
  rippleGrid: ["#ffffff"],
  radar: ["#9f29ff", "#000000"],
  plasma: ["#ffffff", "#000000"],
  particles: ["#ffffff"],
  liquidChrome: ["#1a1a1a", "#000000", "#ffffff"],
  lineWaves: ["#ffffff"],
  iridescence: ["#ffffff", "#000000"],
  grainient: ["#ff9ffc", "#5227ff", "#b497cf"],
  galaxy: ["#ffffff", "#000000"],
  balatro: ["#de443b", "#006bb4", "#162325"],
  waves: ["#ffffff", "#00000000"],
  silk: ["#7b7481"],
  beams: ["#ffffff", "#000000"],
  dither: ["#808080", "#000000"],
  paperMesh: ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"],
  paperWarp: ["#121212", "#9470ff", "#8838ff"],
  paperGrain: ["#000000", "#7300ff", "#eba8ff", "#00bfff", "#2a00ff"],
  paperDither: ["#000000", "#00b2ff"],
  paperSwirl: ["#000000", "#ffd1d1", "#ff8a8a", "#660000"],
  paperMetaballs: ["#000000", "#6e33cc", "#ff5500", "#ffc105", "#f585ff"],
};

/**
 * These shaders do not stay inside the convex hull of their configured input
 * palette. Additive channels, glow, procedural noise or post-contrast can
 * produce both display extremes after the GPU clamps the fragment output.
 * Contrast analysis therefore needs the conservative output gamut, not just
 * the operator-supplied uniforms.
 */
const FULL_OUTPUT_GAMUT_EFFECTS = new Set([
  "softAurora",
  "rippleGrid",
  "radar",
  "particles",
  "liquidChrome",
  "lineWaves",
  "grainient",
  "galaxy",
  "balatro",
]);

function asColor(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

  const colors = [
    ...fromArray(props["colors"]),
    ...fromArray(props["colorStops"]),
    ...fromArray(props["particleColors"]),
    ...[
      "color1",
      "color2",
      "color3",
      "color",
      "colorBack",
      "colorFront",
      "gridColor",
      "lineColor",
      "backgroundColor",
      "lightColor",
    ]
      .map((key) => asColor(props[key]))
      .filter((value): value is string => value !== null),
    ...["baseColor", "waveColor", "color"]
      .map((key) => rgbVectorColor(props[key]))
      .filter((value): value is string => value !== null),
  ];

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
  return configured.length > 0
    ? configured
    : (DEFAULT_EFFECT_COLORS[effect] ?? DEFAULT_AURORA_COLORS);
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
  if (FULL_OUTPUT_GAMUT_EFFECTS.has(effect)) {
    colors.push("#000000", "#ffffff");
  }
  return [...new Set(colors)];
}

function resolveAuroraProps(
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const colors = resolveCardEffectColors("aurora", props);
  const middle = colors[Math.floor((colors.length - 1) / 2)] ?? colors[0];
  const speed = props["speed"];

  return {
    colorStops: [colors[0], middle, colors.at(-1) ?? colors[0]],
    amplitude: 1.05,
    blend: 0.56,
    speed:
      typeof speed === "number" && Number.isFinite(speed)
        ? Math.min(Math.max(speed, 0.15), 1.25)
        : 0.7,
  };
}

export function requiresWebGL2(effect: string): boolean {
  return PAPER_EFFECTS.has(effect);
}

export function requiresWebGL(effect: string): boolean {
  return effect !== "NONE" && !CANVAS_2D_EFFECTS.has(effect);
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
 * only reliable input. Aurora is the shared WebGL1 fallback; the CSS layer is
 * the final no-GPU fallback.
 */
export function resolveCardEffectRuntime({
  effect,
  props,
  capabilities,
  failed = false,
}: {
  readonly effect: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly capabilities: CardEffectCapabilities;
  readonly failed?: boolean;
}): ResolvedCardEffectRuntime {
  if (effect === "NONE") {
    return {
      effect: "NONE",
      props: {},
      mode: "native",
      cssColors: [],
    };
  }

  if (!requiresWebGL(effect)) {
    return failed
      ? resolveCssFallback(effect, props)
      : {
          effect,
          props,
          mode: "native",
          cssColors: [],
        };
  }

  const needsFallback =
    failed ||
    !capabilities.webgl ||
    (requiresWebGL2(effect) && !capabilities.webgl2);

  if (!needsFallback) {
    return {
      effect,
      props,
      mode: "native",
      cssColors: [],
    };
  }

  // Paper shaders require WebGL2. Replacing an operator-selected Warp/Grain
  // with Aurora on a WebGL1-only Telegram WebView changes both its shape and
  // colours. Preserve the selected visual identity with its own CSS palette
  // instead of substituting a different animation.
  if (requiresWebGL2(effect)) {
    return resolveCssFallback(effect, props);
  }

  // Do not retry Aurora after its own context has been lost: that would create
  // a loop of failed contexts. The CSS card treatment is the stable endpoint.
  if (capabilities.webgl && effect !== "aurora") {
    return {
      effect: "aurora",
      props: resolveAuroraProps(props),
      mode: "webgl1-fallback",
      cssColors: [],
    };
  }

  return resolveCssFallback(effect, props);
}
