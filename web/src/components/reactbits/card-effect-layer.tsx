/**
 * CardEffectLayer
 * ───────────────
 * Renders an animated ReactBits effect behind a subscription card. Driven by
 * the operator's branding (`cardEffect` + `cardEffectProps` + opacity) or a
 * per-subscription override.
 *
 * Safety:
 *  - Lazy-loads the effect so the WebGL/canvas code only downloads when used.
 *  - Error boundary falls back to nothing (the card keeps its gradient base).
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

class EffectErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
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

export function CardEffectLayer({ effect, props, opacity = 1, className, active }: CardEffectLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [faded, setFaded] = useState(false);

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

  const isValid = effect !== "NONE" && effect in CARD_EFFECT_COMPONENTS;
  if (!isValid) return null;

  const id = effect as CardEffectId;
  const Effect = CARD_EFFECT_COMPONENTS[id];
  const mergedProps = { ...CARD_EFFECT_DEFAULTS[id], ...(props ?? {}) };

  return (
    <div
      ref={ref}
      aria-hidden
      className={className}
      style={{
        opacity: faded ? Math.min(Math.max(opacity, 0.05), 1) : 0,
        transition: "opacity 450ms ease",
      }}
    >
      {shouldMount && (
        <EffectErrorBoundary resetKey={id}>
          <Suspense fallback={null}>
            <Effect key={id} {...mergedProps} />
          </Suspense>
        </EffectErrorBoundary>
      )}
    </div>
  );
}
