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

export function CardEffectLayer({ effect, props, opacity = 1, className }: CardEffectLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  // Only mount the effect while the card is on screen — pauses GPU work for
  // off-screen carousel slides and scrolled-away cards.
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
      style={{ opacity: Math.min(Math.max(opacity, 0.05), 1) }}
    >
      {visible && (
        <EffectErrorBoundary resetKey={id}>
          <Suspense fallback={null}>
            <Effect key={id} {...mergedProps} />
          </Suspense>
        </EffectErrorBoundary>
      )}
    </div>
  );
}
