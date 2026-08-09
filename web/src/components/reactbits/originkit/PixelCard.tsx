import { useEffect, useRef, type CSSProperties } from 'react';

import { resolveBufferRatio } from '../render-scale';

class Pixel {
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  color: string;
  speed: number;
  size: number;
  sizeStep: number;
  minSize: number;
  maxSizeInteger: number;
  maxSize: number;
  delay: number;
  counter: number;
  counterStep: number;
  isIdle: boolean;
  isReverse: boolean;
  isShimmer: boolean;
  growStart: number | null;
  shrinkStart: number | null;
  shrinkFrom: number;

  constructor(
    width: number,
    height: number,
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    speed: number,
    delay: number,
    maxPx: number
  ) {
    this.width = width;
    this.height = height;
    this.ctx = context;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = this.getRandomValue(0.1, 0.9) * speed;
    this.size = 0;
    // Scale the original 0.5–2px range by the chosen particle size.
    const factor = maxPx / 2;
    this.sizeStep = Math.random() * 0.4 * factor;
    this.minSize = 0.5 * factor;
    this.maxSizeInteger = maxPx;
    this.maxSize = this.getRandomValue(this.minSize, maxPx);
    this.delay = delay;
    this.counter = 0;
    this.counterStep = Math.random() * 4 + (this.width + this.height) * 0.01;
    this.isIdle = false;
    this.isReverse = false;
    this.isShimmer = false;
    this.growStart = null;
    this.shrinkStart = null;
    this.shrinkFrom = 0;
  }

  getRandomValue(min: number, max: number) {
    return Math.random() * (max - min) + min;
  }

  draw() {
    const centerOffset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    this.ctx.fillStyle = this.color;
    this.ctx.fillRect(this.x + centerOffset, this.y + centerOffset, this.size, this.size);
  }

  // Grow-in driven by the transition (duration + ease). The per-pixel `delay`
  // still staggers the start so the sweep order is preserved.
  appear(now: number, durationMs: number, easeFn: (t: number) => number) {
    this.isIdle = false;
    this.shrinkStart = null;
    if (this.counter <= this.delay) {
      this.counter += this.counterStep;
      return;
    }
    if (!this.isShimmer) {
      if (this.growStart === null) this.growStart = now;
      const p = durationMs > 0 ? Math.min(1, (now - this.growStart) / durationMs) : 1;
      this.size = easeFn(p) * this.maxSize;
      if (p >= 1) this.isShimmer = true;
    }
    if (this.isShimmer) {
      this.shimmer();
    }
    this.draw();
  }

  disappear(now: number, durationMs: number, easeFn: (t: number) => number) {
    this.isShimmer = false;
    this.counter = 0;
    this.growStart = null;
    if (this.size <= 0) {
      this.isIdle = true;
      this.shrinkStart = null;
      return;
    }
    if (this.shrinkStart === null) {
      this.shrinkStart = now;
      this.shrinkFrom = this.size;
    }
    const p = durationMs > 0 ? Math.min(1, (now - this.shrinkStart) / durationMs) : 1;
    this.size = this.shrinkFrom * (1 - easeFn(p));
    if (p >= 1) this.size = 0;
    this.draw();
  }

  shimmer() {
    if (this.size >= this.maxSize) {
      this.isReverse = true;
    } else if (this.size <= this.minSize) {
      this.isReverse = false;
    }
    if (this.isReverse) {
      this.size -= this.speed;
    } else {
      this.size += this.speed;
    }
  }
}

function getEffectiveSpeed(value: number) {
  const min = 0;
  const max = 100;
  // Doubled from 0.001 — speed 100 is now 2× the old max; all speeds scale up.
  const throttle = 0.002;

  if (value <= min) {
    return min;
  } else if (value >= max) {
    return max * throttle;
  } else {
    return value * throttle;
  }
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const fx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const dfx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = fx(t) - x;
      const d = dfx(t);
      if (Math.abs(e) < 1e-5 || d === 0) break;
      t -= e / d;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

type EasePreset = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
type EaseBezier = [number, number, number, number];

const EASE_PRESETS: Record<EasePreset, EaseBezier> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1]
};

export interface PixelCardTransition {
  duration?: number;
  ease?: EasePreset | EaseBezier;
}

function makeEase(transition: PixelCardTransition): (t: number) => number {
  const ease = transition.ease;
  if (Array.isArray(ease) && ease.length === 4) return cubicBezier(ease[0], ease[1], ease[2], ease[3]);
  if (typeof ease === 'string' && EASE_PRESETS[ease]) return cubicBezier(...EASE_PRESETS[ease]);
  return cubicBezier(0, 0, 0.58, 1); // default easeOut
}

const DEFAULT_COLORS = ['rgba(255, 255, 255, 1)', 'rgba(255, 255, 255, 0.8)', 'rgba(255, 255, 255, 0.6)'];
const DEFAULT_TRANSITION: PixelCardTransition = { duration: 0.8, ease: 'easeOut' };
const AUTOPILOT_RESUME_MS = 1200;

/**
 * How long the card's box must hold still before the grid is rebuilt.
 *
 * A `ResizeObserver` fires on every integer pixel, and dragging the card's size
 * in the panel walks through a few hundred of them. Each callback threw away
 * roughly 3350 `Pixel` objects, allocated 3350 more, and restarted the entrance
 * from zero — so the card strobed for the length of the drag and never once
 * finished the reveal. Trailing edge only: the rebuild is what is expensive, so
 * it should happen once, after the dragging stops.
 */
const RESIZE_SETTLE_MS = 120;

export interface PixelCardLabelFont {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number | string;
  lineHeight?: number | string;
  letterSpacing?: number | string;
  textAlign?: 'left' | 'center' | 'right';
}

export interface PixelCardLabel {
  text?: string;
  color?: string;
  font?: PixelCardLabelFont;
}

export type PixelCardAppearFrom = 'middle' | 'top' | 'bottom' | 'left' | 'right';

type PixelPhase = 'appear' | 'disappear';

export interface PixelCardProps {
  colors?: string[];
  appearFrom?: PixelCardAppearFrom;
  gap?: number;
  pixelSize?: number;
  speed?: number;
  padding?: number;
  transition?: PixelCardTransition;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  showLabel?: boolean;
  label?: PixelCardLabel;
  autoplay?: boolean;
}

const DEFAULT_LABEL: PixelCardLabel = {
  text: '',
  color: '#ffffff',
  font: { fontSize: '22px', fontWeight: 600, letterSpacing: '-0.01em' }
};

/**
 * Pixel Card
 *
 * A canvas grid of pixels that grows in on hover and shimmers, then shrinks out
 * on leave. Based on the React Bits PixelCard by David Haz. The pixel palette is
 * a user color array, evenly assigned across the pixels.
 */
export default function PixelCard({
  colors = DEFAULT_COLORS,
  appearFrom = 'middle',
  gap = 6,
  pixelSize = 2,
  speed = 80,
  padding = 0,
  transition = DEFAULT_TRANSITION,
  backgroundColor = '#000000',
  borderColor = '#27272a',
  borderWidth = 1,
  radius = 25,
  showLabel = false,
  label = DEFAULT_LABEL,
  autoplay = true
}: PixelCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef<Pixel[]>([]);
  const animationRef = useRef<number | null>(null);
  const resumeRef = useRef<number | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  /**
   * Whether a REAL pointer is holding the reveal open. Outside the effect, so
   * changing a control mid-hover does not drop a revealed card back to blank.
   *
   * This used to be the phase itself, which cannot answer the question: the
   * autopilot leaves the phase at `appear` as well. So every rebuild found
   * `appear` and re-revealed — including the rebuild caused by toggling
   * Autoplay OFF, which is why that control looked inert. Asking who is holding
   * it lets the toggle mean what it says.
   */
  const pointerHeldRef = useRef(false);
  const timePreviousRef = useRef(typeof performance !== 'undefined' ? performance.now() : 0);

  const easeFn = makeEase(transition);
  const durationMs = (transition.duration ?? 0.8) * 1000;
  const finalColors = colors && colors.length > 0 ? colors : DEFAULT_COLORS;
  const colorKey = finalColors.join('|');

  // Everything the loop needs is held in refs so the rAF closure never goes stale.
  const runtimeRef = useRef({ easeFn, durationMs, autoplay });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    runtimeRef.current = { easeFn, durationMs, autoplay };
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const clearLoop = () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
    const clearResume = () => {
      if (resumeRef.current !== null) {
        clearTimeout(resumeRef.current);
        resumeRef.current = null;
      }
    };

    // A rebuild (resize) throws away every Pixel and starts them all at size 0,
    // so without remembering the phase a resize would leave an already-revealed
    // card blank for good whenever `autoplay` is off — nothing else ever
    // restarts the loop.
    const doAnimate = (phase: PixelPhase) => {
      animationRef.current = requestAnimationFrame(() => doAnimate(phase));
      const timeNow = performance.now();
      const timePassed = timeNow - timePreviousRef.current;
      const timeInterval = 1000 / 60;
      if (timePassed < timeInterval) return;
      timePreviousRef.current = timeNow - (timePassed % timeInterval);

      const { width, height } = sizeRef.current;
      ctx.clearRect(0, 0, width, height);

      let allIdle = true;
      const { easeFn: ease, durationMs: duration } = runtimeRef.current;
      for (const pixel of pixelsRef.current) {
        pixel[phase](timeNow, duration, ease);
        if (!pixel.isIdle) allIdle = false;
      }
      if (allIdle) clearLoop();
    };

    const handleAnimation = (phase: PixelPhase) => {
      clearLoop();
      animationRef.current = requestAnimationFrame(() => doAnimate(phase));
    };

    const initPixels = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.floor(rect.width || container.clientWidth || 0);
      const height = Math.floor(rect.height || container.clientHeight || 0);
      if (width <= 0 || height <= 0) return false;

      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      const dpr = resolveBufferRatio(width, height, Math.min(window.devicePixelRatio || 1, 2));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Assigning `canvas.width` is specified to reset the bitmap even when the
      // number does not change, but this rebuild is also the only thing that
      // erases the card when `present()` declines to reveal — which is how
      // turning Autoplay off becomes visible — so the clear is stated outright
      // rather than inherited from a side effect.
      ctx.clearRect(0, 0, width, height);
      sizeRef.current = { width, height };

      const step = Math.max(1, Math.floor(gap));
      const pxs: Pixel[] = [];
      let idx = 0;
      for (let x = 0; x < width; x += step) {
        for (let y = 0; y < height; y += step) {
          // Evenly assign the palette across pixels (cycle by index).
          const c = finalColors[idx % finalColors.length];
          idx++;

          let delay: number;
          if (appearFrom === 'top') {
            delay = y;
          } else if (appearFrom === 'bottom') {
            delay = height - y;
          } else if (appearFrom === 'left') {
            delay = x;
          } else if (appearFrom === 'right') {
            delay = width - x;
          } else {
            const dx = x - width / 2;
            const dy = y - height / 2;
            delay = Math.sqrt(dx * dx + dy * dy);
          }
          pxs.push(new Pixel(width, height, ctx, x, y, c, getEffectiveSpeed(speed), delay, Math.max(0.1, pixelSize)));
        }
      }
      pixelsRef.current = pxs;
      return true;
    };

    // Autopilot: the Framer build only ever started the loop from a real hover,
    // which never arrives on a touch device. With `autoplay` the reveal runs on
    // mount and the shimmer keeps going with no pointer at all.
    //
    // After a rebuild this also has to restore a reveal that a real pointer had
    // already triggered, or a resize while `autoplay` is off blanks the card
    // permanently. `disappear` needs no replay: assigning `canvas.width` in
    // `initPixels` has already cleared the canvas, which is what that phase
    // draws anyway — and that is also what makes turning Autoplay off visible,
    // since the effect rebuilds on that dependency and this then declines to
    // reveal.
    const present = () => {
      if (runtimeRef.current.autoplay || pointerHeldRef.current) handleAnimation('appear');
    };

    if (initPixels()) present();

    // Pointer, not mouse. `mouseenter`/`mouseleave` are the only inputs this
    // component had, and a touch device fires neither — with `autoplay` off the
    // canvas stayed empty for the life of the mount, whatever the visitor did.
    // Nothing here calls preventDefault, so a swipe that starts on the card
    // still scrolls; `pointercancel` covers the webview taking that swipe over.
    const onPointerEnter = () => {
      pointerHeldRef.current = true;
      clearResume();
      handleAnimation('appear');
    };

    // A touch is not a hover, and its leave is not a departure. A tap fires
    // enter → up → leave within a few frames, so routing that leave into
    // `disappear` un-revealed the card about nine frames into a ~27-frame
    // stagger: the reveal never finished, the counter was reset, and with
    // `autoplay` off the card was left blank — a tap that visibly undid itself.
    // A touch therefore only ever reveals, and the reveal latches: nothing on
    // this component asks a finger to stay put, so there is no later event that
    // could honestly mean "the visitor has gone".
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      pointerHeldRef.current = false;
      clearResume();
      handleAnimation('disappear');
      if (runtimeRef.current.autoplay) {
        // Hand control back to the autopilot a beat after the pointer leaves.
        resumeRef.current = window.setTimeout(() => {
          resumeRef.current = null;
          handleAnimation('appear');
        }, AUTOPILOT_RESUME_MS);
      }
    };

    container.addEventListener('pointerenter', onPointerEnter);
    container.addEventListener('pointerleave', onPointerLeave);
    container.addEventListener('pointercancel', onPointerLeave);

    let resizeTimer: number | null = null;
    const clearResize = () => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
    };
    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      if (width === sizeRef.current.width && height === sizeRef.current.height) return;
      // Trailing edge only — see `RESIZE_SETTLE_MS`. The canvas keeps its old
      // backing size until then, so the picture stretches for a moment rather
      // than restarting, which is the cheaper of the two artefacts by far.
      clearResize();
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (initPixels()) present();
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      container.removeEventListener('pointerenter', onPointerEnter);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('pointercancel', onPointerLeave);
      clearResize();
      clearResume();
      clearLoop();
      pixelsRef.current = [];
    };
  }, [gap, pixelSize, speed, appearFrom, colorKey, autoplay]);

  const labelFont = label.font ?? {};
  const labelStyle: CSSProperties = {
    color: label.color ?? '#ffffff',
    fontFamily: labelFont.fontFamily,
    fontWeight: labelFont.fontWeight ?? 600,
    fontSize: labelFont.fontSize ?? 22,
    lineHeight: labelFont.lineHeight,
    letterSpacing: labelFont.letterSpacing ?? '-0.01em',
    textAlign: labelFont.textAlign
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 h-full w-full overflow-hidden"
      style={{
        boxSizing: 'border-box',
        padding,
        background: backgroundColor,
        display: 'grid',
        placeItems: 'center',
        border: `${borderWidth}px solid ${borderColor}`,
        borderRadius: radius,
        isolation: 'isolate',
        userSelect: 'none'
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" style={{ gridArea: '1 / 1' }} />
      {showLabel && label.text ? (
        <div
          className="pointer-events-none relative grid place-items-center"
          style={{ gridArea: '1 / 1', zIndex: 1 }}
        >
          <span style={labelStyle}>{label.text}</span>
        </div>
      ) : null}
    </div>
  );
}
