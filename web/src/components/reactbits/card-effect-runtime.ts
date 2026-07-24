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

function asColor(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function configuredColors(props: Readonly<Record<string, unknown>>): string[] {
  const fromArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map(asColor).filter((value): value is string => value !== null)
      : [];

  const colors = fromArray(props["colors"]);
  if (colors.length > 0) return colors;

  const stops = fromArray(props["colorStops"]);
  if (stops.length > 0) return stops;

  return [props["color1"], props["color2"], props["color3"], props["colorBack"]]
    .map(asColor)
    .filter((value): value is string => value !== null);
}

export function resolveCardEffectColors(
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const colors = configuredColors(props);
  return colors.length > 0 ? colors : DEFAULT_AURORA_COLORS;
}

function resolveAuroraProps(
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const colors = resolveCardEffectColors(props);
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
  props: Readonly<Record<string, unknown>>,
): ResolvedCardEffectRuntime {
  return {
    effect: "NONE",
    props: {},
    mode: "css-fallback",
    cssColors: resolveCardEffectColors(props),
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
      ? resolveCssFallback(props)
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

  return resolveCssFallback(props);
}
