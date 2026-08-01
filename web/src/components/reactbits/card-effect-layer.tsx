/**
 * CardEffectLayer
 * ───────────────
 * Renders an animated ReactBits effect behind a subscription card. Driven by
 * the operator's branding (`cardEffect` + `cardEffectProps` + opacity) or a
 * per-subscription override.
 *
 * Safety:
 *  - Lazy-loads the effect so the WebGL/canvas code only downloads when used.
 *  - Degrades GPU failures through Aurora/WebGL1 to a themed CSS layer.
 *  - Only renders while on-screen (IntersectionObserver) so off-screen carousel
 *    slides and scrolled-away cards pause their GPU work.
 *
 * Card artwork is an operator-selected part of the brand and must render the
 * same way in the live cabinet as it does in the Rezeis preview. It is
 * therefore not disabled by the browser's decorative reduced-motion hint.
 * CSS fallback is reserved for genuine canvas/WebGL capability failures.
 */

import {
  Component,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  CARD_EFFECT_COMPONENTS,
  CARD_EFFECT_DEFAULTS,
  type CardEffectId,
} from "./registry";
import {
  detectCardEffectCapabilities,
  requiresWebGL,
  resolveCardEffectColors,
  resolveCardEffectRuntime,
} from "./card-effect-runtime";

interface CardEffectLayerProps {
  readonly effect: string;
  readonly props?: Record<string, unknown>;
  readonly opacity?: number;
  readonly className?: string;
  /**
   * Carousel ownership hint. The parent passes `true` only to the selected
   * slide, guaranteeing that one subscription at most owns a live WebGL/canvas
   * renderer. Left `undefined` for standalone usage, where the
   * IntersectionObserver below drives mounting.
   */
  readonly active?: boolean;
}

/**
 * The effect-opacity control is part of the operator's published card design.
 * Do not impose a second, hidden ceiling here: a saved 100% must remain 100%
 * in both the live cabinet and Rezeis preview. The card gradient is a separate
 * foundation layer, so this clamp only protects the valid input range.
 */
export function resolveCardEffectOverlayOpacity(opacity: number): number {
  return Math.min(Math.max(opacity, 0.05), 1);
}

class EffectErrorBoundary extends Component<{
  children: ReactNode;
  resetKey: string;
  onError: () => void;
}, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

function CssEffectFallback({
  colors,
  opacity,
}: {
  readonly colors: readonly string[];
  readonly opacity: number;
}) {
  const first = colors[0] ?? "#5227FF";
  const middle = colors[Math.floor((colors.length - 1) / 2)] ?? first;
  const last = colors.at(-1) ?? middle;

  return (
    <div
      aria-hidden
      data-card-effect-artwork
      className="card-effect-layer__css-fallback absolute inset-0"
      style={{
        // The fallback remains alpha artwork. A full-frame opaque gradient
        // here would replace a custom card gradient as soon as an unavailable
        // WebGL effect falls back. Screen compositing makes black shader
        // regions neutral while preserving the selected colours and intensity.
        backgroundImage: `radial-gradient(70% 110% at 4% 100%, ${first} 0%, transparent 72%), radial-gradient(66% 100% at 100% 2%, ${last} 0%, transparent 72%), radial-gradient(54% 66% at 52% 50%, ${middle} 0%, transparent 82%)`,
        opacity,
        mixBlendMode: "screen",
      }}
    />
  );
}

function EffectReadySignal({
  presentationKey,
  onReady,
}: {
  readonly presentationKey: string;
  readonly onReady: (key: string) => void;
}) {
  useEffect(() => {
    onReady(presentationKey);
  }, [onReady, presentationKey]);

  return null;
}

export function CardEffectLayer({
  effect,
  props,
  opacity = 1,
  className,
  active,
}: CardEffectLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [readyPresentationKey, setReadyPresentationKey] = useState<
    string | null
  >(null);
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<{
    readonly effect: string;
    readonly capabilities: ReturnType<typeof detectCardEffectCapabilities>;
  } | null>(null);
  const [effectFailed, setEffectFailed] = useState(false);

  // Mount the effect while the card is on screen (standalone usage). In the
  // carousel the parent passes an explicit `active` boolean: in that mode it
  // drives mounting EXCLUSIVELY (ignore the IntersectionObserver) so that at
  // most ONE card holds a live WebGL context at a time — mobile browsers cap
  // contexts at ~8 and the "oldest context will be lost" thrash is exactly the
  // flicker/under-load users see with several subscriptions.
  useEffect(() => {
    if (active !== undefined) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  const shouldMount = active === undefined ? visible : active;
  const shouldAnimate = shouldMount;
  const isValid = effect !== "NONE" && effect in CARD_EFFECT_COMPONENTS;

  useEffect(() => {
    setEffectFailed(false);
  }, [effect]);

  useEffect(() => {
    if (!shouldAnimate || !isValid || !requiresWebGL(effect)) {
      setCapabilitySnapshot(null);
      return;
    }
    const capabilities = detectCardEffectCapabilities();
    // `WEBGL_lose_context` releases the short-lived probe asynchronously in
    // WebKit. Wait one frame before mounting the real renderer so the probe
    // cannot momentarily consume the iOS context budget.
    const frame = window.requestAnimationFrame(() => {
      setCapabilitySnapshot({ effect, capabilities });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [effect, isValid, shouldAnimate]);

  const sourceProps = props ?? {};
  const staticProps = isValid
    ? {
        ...CARD_EFFECT_DEFAULTS[effect as CardEffectId],
        ...sourceProps,
      }
    : sourceProps;
  const capabilities =
    capabilitySnapshot?.effect === effect
      ? capabilitySnapshot.capabilities
      : null;
  const runtime =
    !isValid || (requiresWebGL(effect) && capabilities === null)
      ? null
      : resolveCardEffectRuntime({
          effect,
          props: sourceProps,
          capabilities: capabilities ?? { webgl: false, webgl2: false },
          failed: effectFailed,
        });
  const runtimeId = runtime?.effect as CardEffectId | "NONE" | undefined;
  const Effect =
    runtimeId === undefined || runtimeId === "NONE"
      ? null
      : CARD_EFFECT_COMPONENTS[runtimeId];
  const mergedProps =
    runtimeId === undefined || runtimeId === "NONE"
      ? {}
      : { ...CARD_EFFECT_DEFAULTS[runtimeId], ...(runtime?.props ?? {}) };
  const effectColors =
    runtimeId === undefined || runtimeId === "NONE"
      ? runtime?.cssColors ?? resolveCardEffectColors(effect, staticProps)
      : resolveCardEffectColors(runtimeId, mergedProps);
  const configuredOpacity = resolveCardEffectOverlayOpacity(opacity);
  const presentationKey =
    runtime === null
      ? null
      : `${effect}:${runtime.effect}:${runtime.mode}:${effectFailed ? "fallback" : "native"}`;
  const presentationReady =
    shouldMount &&
    presentationKey !== null &&
    (runtime?.mode === "css-fallback" ||
      readyPresentationKey === presentationKey);

  useEffect(() => {
    if (
      !isValid ||
      !shouldMount ||
      runtimeId === undefined ||
      runtimeId === "NONE"
    ) {
      return;
    }
    const root = ref.current;
    if (root === null) return;

    const listeners = new Map<HTMLCanvasElement, () => void>();
    const markFailed = () => setEffectFailed(true);
    const observeCanvas = () => {
      root.querySelectorAll("canvas").forEach((canvas) => {
        if (listeners.has(canvas)) return;
        canvas.addEventListener("webglcontextlost", markFailed);
        canvas.addEventListener("webglcontextcreationerror", markFailed);
        listeners.set(canvas, () => {
          canvas.removeEventListener("webglcontextlost", markFailed);
          canvas.removeEventListener("webglcontextcreationerror", markFailed);
        });
      });
    };
    const observer = new MutationObserver(observeCanvas);
    observer.observe(root, { childList: true, subtree: true });
    observeCanvas();

    return () => {
      observer.disconnect();
      listeners.forEach((remove) => remove());
    };
  }, [isValid, runtimeId, shouldMount]);

  if (!isValid) return null;

  return (
    <div
      ref={ref}
      aria-hidden
      className={className}
      data-card-effect-source={effect}
      data-card-effect-runtime={runtime?.mode ?? "probing"}
      data-card-effect-ready={presentationReady ? "true" : "false"}
      style={{
        // The card gradient/pattern stay visible both before and after the
        // lazy renderer mounts. Only the artwork itself has opacity; fading a
        // full layer here caused a foreign colour flash during readiness.
        opacity: 1,
        isolation: "isolate",
        overflow: "hidden",
        contain: "paint",
      }}
    >
      {runtime?.mode === "css-fallback" && (
        <div
          data-card-effect-palette-surface
          className="absolute inset-0"
        >
          <CssEffectFallback
            colors={effectColors}
            opacity={configuredOpacity}
          />
        </div>
      )}
      {shouldAnimate &&
        Effect !== null &&
        runtimeId !== undefined &&
        runtimeId !== "NONE" && (
          <EffectErrorBoundary
            resetKey={`${effect}:${runtimeId}:${effectFailed ? "fallback" : "native"}`}
            onError={() => setEffectFailed(true)}
          >
            <Suspense fallback={null}>
              <div
                data-card-effect-renderer
                className="absolute inset-0"
                style={{
                  opacity: configuredOpacity,
                  // Paper and a few third-party canvases paint an opaque
                  // black base. Composite those pixels instead of allowing
                  // them to erase the operator's gradient beneath.
                  mixBlendMode: "screen",
                }}
              >
                <Effect key={runtimeId} {...mergedProps} />
              </div>
              {presentationKey !== null && (
                <EffectReadySignal
                  presentationKey={presentationKey}
                  onReady={setReadyPresentationKey}
                />
              )}
            </Suspense>
          </EffectErrorBoundary>
        )}
    </div>
  );
}
