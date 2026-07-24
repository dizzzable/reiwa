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
 * Note on motion: the background is purely decorative (`aria-hidden`) and the
 * operator explicitly opts into it via branding, so we intentionally do NOT
 * gate it behind `prefers-reduced-motion` — many desktops report "reduce"
 * simply because OS animations are off, which would otherwise silently drop the
 * operator's configured card background entirely.
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
  resolveCardEffectRuntime,
} from "./card-effect-runtime";

interface CardEffectLayerProps {
  readonly effect: string;
  readonly props?: Record<string, unknown>;
  readonly opacity?: number;
  readonly className?: string;
  /**
   * Carousel pre-warm hint. When `true`, the effect mounts even while the
   * card is off-screen, so the next/prev slide's WebGL context + shaders are
   * already initialised before the user swipes to it (the parent passes
   * `true` for the active card and its immediate neighbours). This can't be
   * done with `IntersectionObserver` alone: the carousel's `overflow-x-auto`
   * track clips off-screen slides, so a viewport `rootMargin` never sees them.
   * Left `undefined` for standalone usage, where the IntersectionObserver
   * below drives mounting.
   */
  readonly active?: boolean;
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

function CssEffectFallback({ colors }: { readonly colors: readonly string[] }) {
  const first = colors[0] ?? "#5227FF";
  const middle = colors[Math.floor((colors.length - 1) / 2)] ?? first;
  const last = colors.at(-1) ?? middle;

  return (
    <div
      aria-hidden
      className="card-effect-layer__css-fallback absolute inset-0"
      style={{
        backgroundImage: `radial-gradient(95% 135% at 4% 100%, ${first} 0%, transparent 64%), radial-gradient(85% 120% at 100% 2%, ${last} 0%, transparent 60%), linear-gradient(135deg, ${first}, ${middle}, ${last})`,
      }}
    />
  );
}

export function CardEffectLayer({ effect, props, opacity = 1, className, active }: CardEffectLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [faded, setFaded] = useState(false);
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
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const shouldMount = active === undefined ? visible : active;
  const isValid = effect !== "NONE" && effect in CARD_EFFECT_COMPONENTS;

  useEffect(() => {
    setEffectFailed(false);
  }, [effect]);

  useEffect(() => {
    if (!shouldMount || !isValid || !requiresWebGL(effect)) {
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
  }, [effect, isValid, shouldMount]);

  // Fade the effect in over the always-present static gradient base so it
  // appears smoothly instead of popping after WebGL init. Reset when unmounted
  // so a remount fades again.
  useEffect(() => {
    if (!shouldMount) {
      setFaded(false);
      return;
    }
    const id = requestAnimationFrame(() => setFaded(true));
    return () => cancelAnimationFrame(id);
  }, [shouldMount]);

  const sourceProps = props ?? {};
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
      style={{
        opacity: faded ? Math.min(Math.max(opacity, 0.05), 1) : 0,
        transition: "opacity 450ms ease",
      }}
    >
      {runtime?.mode === "css-fallback" && (
        <CssEffectFallback colors={runtime.cssColors} />
      )}
      {shouldMount && Effect !== null && runtimeId !== undefined && runtimeId !== "NONE" && (
        <EffectErrorBoundary
          resetKey={`${effect}:${runtimeId}:${effectFailed ? "fallback" : "native"}`}
          onError={() => setEffectFailed(true)}
        >
          <Suspense fallback={null}>
            <Effect key={runtimeId} {...mergedProps} />
          </Suspense>
        </EffectErrorBoundary>
      )}
    </div>
  );
}
