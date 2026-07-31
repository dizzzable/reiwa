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
 * Reduced motion keeps a static CSS rendition of the configured palette and
 * does not mount the native canvas/WebGL renderer. The selected palette stays
 * visually complete without forcing an infinite decorative animation.
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

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reduced;
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
      className="absolute inset-0"
      style={{
        backgroundColor: first,
      }}
    >
      <div
        data-card-effect-artwork
        className="card-effect-layer__css-fallback absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(95% 135% at 4% 100%, ${first} 0%, transparent 64%), radial-gradient(85% 120% at 100% 2%, ${last} 0%, transparent 60%), linear-gradient(135deg, ${first}, ${middle}, ${last})`,
          opacity,
        }}
      />
    </div>
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
  const prefersReducedMotion = usePrefersReducedMotion();

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
  const shouldAnimate = shouldMount && !prefersReducedMotion;
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
  const runtime = prefersReducedMotion && isValid
    ? {
        effect: "NONE",
        props: {},
        mode: "css-fallback" as const,
        cssColors: resolveCardEffectColors(effect, staticProps),
      }
    : !isValid || (requiresWebGL(effect) && capabilities === null)
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
  const configuredOpacity = Math.min(Math.max(opacity, 0.05), 1);
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
        // Keep the theme card visible as the cheap lazy placeholder. Once the
        // selected effect is ready, this surface becomes fully opaque so the
        // theme gradient and pattern cannot tint or desaturate the artwork.
        opacity: presentationReady ? 1 : 0,
        transition: prefersReducedMotion ? "none" : "opacity 450ms ease",
        isolation: "isolate",
        overflow: "hidden",
        contain: "paint",
      }}
    >
      {runtime !== null && (
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
                style={{ opacity: configuredOpacity }}
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
