import { useEffect, useRef, type CSSProperties } from "react";

import { resolveBufferRatio } from '../render-scale';

/**
 * Reactive Grid — Originkit `reactivegrid`, ported to the card-effect shape.
 *
 * Canvas 2D. A grid of shapes that swell as the cursor nears them.
 *
 * WHY IT LOOKED BROKEN, and the fix
 * ---------------------------------
 * The rAF loop always ran; the problem was that every cell's size came from
 * cursor distance alone and `mouseRef` started `null`, so `infl` was 0 for all
 * cells and the grid drew one uniform still frame forever. There is no time
 * term anywhere in the original — the `sin`/`cos` calls are polygon vertex
 * geometry, not motion.
 *
 * So the fix is not a new loop but a synthetic cursor: `autoPoint` walks a
 * point around the box on two sine terms per axis whose periods (40 s, 30 s,
 * 15 s, 12 s) share no small common multiple, so the path wanders for minutes
 * without retracing. A real pointer still wins — `blend` eases to 0 within a
 * few frames of a `pointermove`, and after the pointer leaves it dwells for
 * 600 ms and then eases back to 1 over about two seconds, so the swell glides
 * off the release point onto the synthetic path instead of snapping back.
 * Set `autoplay={false}` for the original pointer-only behaviour.
 */

type Shape = "square" | "rounded" | "circle" | "triangle" | "diamond" | "hexagon" | "star";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Milliseconds the effect holds still at the release point before drifting off. */
const AUTOPILOT_DWELL_MS = 600;
/** Time constant easing back into autopilot; ~2 s to settle. */
const AUTOPILOT_IN_TAU = 0.9;
/** Time constant yielding to a real pointer; a few frames. */
const AUTOPILOT_OUT_TAU = 0.12;
/**
 * Milliseconds of silence after which a pointer counts as gone even though no
 * `pointerleave` ever arrived. It does not always arrive — the webview takes
 * over a swipe, a sheet is dismissed mid-touch — and without this the swell
 * stays pinned to the last touched point for the life of the mount.
 */
const POINTER_IDLE_MS = 3000;

/**
 * The smallest a resting particle is allowed to be while `autoplay` is off.
 *
 * With `autoplay` off nothing ever moves the influence point unless a real
 * pointer is on the card, so every cell sits at `minSize` — for the whole life
 * of the mount on any touch device, and until the first hover on a desktop. At
 * `minSize` 0 the size loop then skips every cell and the card is a flat
 * rectangle of `backgroundColor` painted over the operator's gradient: two
 * ordinary panel controls, no warning, nothing drawn.
 *
 * The floor is deliberately NOT applied while `autoplay` is on. There a
 * synthetic cursor always exists, so `minSize` 0 means what it says — cells
 * away from the swell vanish completely — and that is a look worth keeping.
 * The catalogue's slider stops at this same number, so the panel cannot ask for
 * a value the component would silently overrule.
 */
const MIN_RESTING_SIZE = 2;

/**
 * The synthetic cursor. Two sine terms per axis, incommensurable periods, so
 * the walk covers the whole box and grazes just past its edges.
 */
function autoPointX(t: number) {
  return 0.5 + 0.4 * Math.sin(t * 0.21) + 0.12 * Math.sin(t * 0.53 + 1.1);
}
function autoPointY(t: number) {
  return 0.5 + 0.38 * Math.sin(t * 0.157 + 2.4) + 0.13 * Math.sin(t * 0.41 + 0.3);
}

export interface ReactiveGridProps {
  /** Particle shape drawn in each grid cell. */
  shape?: Shape;
  /** Solid fill or outlined stroke. */
  fill?: "solid" | "stroke";
  /** Outline thickness when `fill` is `"stroke"`. */
  strokeWidth?: number;
  /** Fill or stroke colour of the particles. */
  particleColor?: string;
  /** Background colour behind the grid. */
  backgroundColor?: string;
  /** Size a particle grows to when the cursor is directly over it. */
  maxSize?: number;
  /**
   * Resting particle size when the cursor is far away. Honoured exactly while
   * `autoplay` is on; floored at `MIN_RESTING_SIZE` when it is off, where every
   * cell rests forever and 0 would draw an empty card.
   */
  minSize?: number;
  /** Spacing between particles; combines with `maxSize` to define the cell. */
  gap?: number;
  /** Radius around the cursor where particles begin to grow. */
  influence?: number;
  /** Drive a synthetic cursor when no real one is present. */
  autoplay?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface LiveProps {
  shape: Shape;
  fill: "solid" | "stroke";
  strokeWidth: number;
  particleColor: string;
  backgroundColor: string;
  maxSize: number;
  minSize: number;
  gap: number;
  influence: number;
  autoplay: boolean;
}

export default function ReactiveGrid({
  shape = "rounded",
  fill = "solid",
  strokeWidth = 1.5,
  particleColor = "#FFFFFF",
  backgroundColor = "#000000",
  maxSize = 36,
  minSize = 12,
  gap = 4,
  // Must match the catalog's control default. Nothing merges the catalog in on
  // the render path, so a stored props record without this key falls through to
  // here — and at 300 every cell on a card sits near `maxSize`, which reads as
  // one vague mass rather than a grid.
  influence = 120,
  autoplay = true,
  className = "",
  style,
}: ReactiveGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef<LiveProps>({
    shape,
    fill,
    strokeWidth,
    particleColor,
    backgroundColor,
    maxSize,
    minSize,
    gap,
    influence,
    autoplay,
  });

  useEffect(() => {
    propsRef.current = {
      shape,
      fill,
      strokeWidth,
      particleColor,
      backgroundColor,
      maxSize,
      minSize,
      gap,
      influence,
      autoplay,
    };
  }, [
    shape,
    fill,
    strokeWidth,
    particleColor,
    backgroundColor,
    maxSize,
    minSize,
    gap,
    influence,
    autoplay,
  ]);

  useEffect(() => {
    const containerEl = containerRef.current;
    const canvasEl = canvasRef.current;
    if (!containerEl || !canvasEl) return;
    const context = canvasEl.getContext("2d");
    if (!context) return;
    const container: HTMLDivElement = containerEl;
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context;

    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let sizes = new Float32Array(0);

    let startTime = 0;
    let lastTime = 0;
    let blend = 1;
    let pointerActive = false;
    let leftAt = 0;
    let movedAt = 0;
    let lastX = 0;
    let lastY = 0;

    function syncSize() {
      const rect = container.getBoundingClientRect();
      const nextW = rect.width;
      const nextH = rect.height;
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      const nextDpr = resolveBufferRatio(nextW, nextH, Math.min(Math.max(1, window.devicePixelRatio || 1), 2));
      if (w === nextW && h === nextH && dpr === nextDpr) return;
      w = nextW;
      h = nextH;
      dpr = nextDpr;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!pointerActive && !leftAt) {
        lastX = w / 2;
        lastY = h / 2;
      }
    }

    function buildPath(cx: number, cy: number, s: number, shp: Shape) {
      const half = s / 2;
      ctx.beginPath();
      switch (shp) {
        case "circle":
          ctx.arc(cx, cy, half, 0, Math.PI * 2);
          break;
        case "rounded": {
          const r = Math.min(half, s * 0.28);
          const x = cx - half;
          const y = cy - half;
          ctx.moveTo(x + r, y);
          ctx.arcTo(x + s, y, x + s, y + s, r);
          ctx.arcTo(x + s, y + s, x, y + s, r);
          ctx.arcTo(x, y + s, x, y, r);
          ctx.arcTo(x, y, x + s, y, r);
          ctx.closePath();
          break;
        }
        case "triangle":
          ctx.moveTo(cx, cy - half);
          ctx.lineTo(cx + half, cy + half);
          ctx.lineTo(cx - half, cy + half);
          ctx.closePath();
          break;
        case "diamond":
          ctx.moveTo(cx, cy - half);
          ctx.lineTo(cx + half, cy);
          ctx.lineTo(cx, cy + half);
          ctx.lineTo(cx - half, cy);
          ctx.closePath();
          break;
        case "hexagon":
          for (let k = 0; k < 6; k++) {
            const a = ((-90 + 60 * k) * Math.PI) / 180;
            const px = cx + half * Math.cos(a);
            const py = cy + half * Math.sin(a);
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          break;
        case "star": {
          const inner = half * 0.5;
          for (let k = 0; k < 10; k++) {
            const rad = k % 2 === 0 ? half : inner;
            const a = ((-90 + 36 * k) * Math.PI) / 180;
            const px = cx + rad * Math.cos(a);
            const py = cy + rad * Math.sin(a);
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          break;
        }
        default:
          ctx.rect(cx - half, cy - half, s, s);
      }
    }

    function draw(time: number) {
      const p = propsRef.current;
      if (!startTime) startTime = time;
      const dtSec = lastTime ? Math.min(time - lastTime, 100) / 1000 : 1 / 60;
      lastTime = time;
      const t = (time - startTime) / 1000;

      // Ease between the real pointer and the synthetic one. `wantsAuto` is
      // false while a pointer is down or hovering, and for a short dwell after
      // it leaves, so the swell lingers before it drifts away. A pointer that
      // stopped reporting without ever leaving is treated as gone, so the
      // autopilot always comes back.
      if (pointerActive && time - movedAt > POINTER_IDLE_MS) {
        pointerActive = false;
        leftAt = time;
      }
      const dwelling = !pointerActive && leftAt > 0 && time - leftAt < AUTOPILOT_DWELL_MS;
      const wantsAuto = p.autoplay && !pointerActive && !dwelling;
      const target = wantsAuto ? 1 : 0;
      const tau = wantsAuto ? AUTOPILOT_IN_TAU : AUTOPILOT_OUT_TAU;
      blend += (target - blend) * (1 - Math.exp(-dtSec / tau));

      let mouseX = 0;
      let mouseY = 0;
      let hasMouse = false;
      if (p.autoplay) {
        hasMouse = true;
        const ax = autoPointX(t) * w;
        const ay = autoPointY(t) * h;
        mouseX = lerp(lastX, ax, blend);
        mouseY = lerp(lastY, ay, blend);
      } else if (pointerActive) {
        hasMouse = true;
        mouseX = lastX;
        mouseY = lastY;
      }

      const isStroke = p.fill === "stroke";
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = p.backgroundColor;
      ctx.fillRect(0, 0, w, h);

      const cell = Math.max(1, p.maxSize + p.gap);
      const cols = Math.max(1, Math.floor(w / cell));
      const rows = Math.max(1, Math.floor(h / cell));
      const offX = (w - cols * cell) / 2 + cell / 2;
      const offY = (h - rows * cell) / 2 + cell / 2;
      const count = cols * rows;
      // See `MIN_RESTING_SIZE`. The floor is on the resting end of the lerp
      // only, so `maxSize` and the swell itself are untouched.
      const rest = p.autoplay ? p.minSize : Math.max(p.minSize, MIN_RESTING_SIZE);
      if (sizes.length !== count) sizes = new Float32Array(count).fill(rest);

      ctx.fillStyle = p.particleColor;
      ctx.strokeStyle = p.particleColor;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(0.5, p.strokeWidth);

      const radius = Math.max(1, p.influence);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          const cx = offX + i * cell;
          const cy = offY + j * cell;
          let infl = 0;
          if (hasMouse) {
            const dx = mouseX - cx;
            const dy = mouseY - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            infl = clamp(1 - dist / radius, 0, 1);
          }
          const target2 = lerp(rest, p.maxSize, infl);
          const cur = lerp(sizes[idx] || rest, target2, 0.2);
          sizes[idx] = cur;
          if (cur <= 0.2) continue;
          buildPath(cx, cy, cur, p.shape);
          if (isStroke) ctx.stroke();
          else ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    }

    function onMove(e: PointerEvent) {
      const rect = container.getBoundingClientRect();
      lastX = e.clientX - rect.left;
      lastY = e.clientY - rect.top;
      pointerActive = true;
      movedAt = performance.now();
      leftAt = 0;
    }
    function onLeave() {
      if (!pointerActive) return;
      pointerActive = false;
      leftAt = performance.now();
    }

    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);
    container.addEventListener("pointermove", onMove, { passive: true });
    container.addEventListener("pointerleave", onLeave, { passive: true });
    container.addEventListener("pointercancel", onLeave, { passive: true });
    raf = requestAnimationFrame(draw);

    return () => {
      ro.disconnect();
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("pointercancel", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ backgroundColor, ...style }}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
