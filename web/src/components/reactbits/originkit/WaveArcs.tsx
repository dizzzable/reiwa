import { useEffect, useRef, type CSSProperties } from "react";

import { resolveBufferRatio } from '../render-scale';

/**
 * Wave Arcs — Originkit `wave-arcs`, ported to the card-effect shape.
 *
 * Canvas 2D. A fan of tangent-driven circular arcs sweeps continuously; the
 * pointer's vertical position only tilts the fan, so the piece animates with no
 * input at all.
 *
 * Changed from the capture:
 *
 * - The sweep phase came from `state.frameCount`, incremented once per rAF with
 *   no clock, so it swept twice as fast on a 120 Hz display. The phase now
 *   accumulates elapsed time against a 60 Hz reference; 60 Hz looks identical.
 * - The tilt listener was `mousemove` on `document`; it is now `pointermove` /
 *   `pointerleave` on the component's own container, per the house rule. That
 *   also removed the `scroll` listener the original needed to keep a cached
 *   container rect valid.
 * - `visibilitychange` on `document` dropped: rAF is already suspended for a
 *   hidden tab, so it bought nothing and broke the no-document-listeners rule.
 * - The idle-callback deferred start is gone — it existed to protect Next.js
 *   hydration. The IntersectionObserver pause is kept; it starts optimistically
 *   visible, so the worst case is drawing one frame that nobody sees.
 * - Device pixel ratio is capped at 2.
 */

const REF_FRAME_MS = 1000 / 60;
const TWO_PI = 2 * Math.PI;

const map = (v: number, a: number, b: number, c: number, d: number) => ((v - a) / (b - a)) * (d - c) + c;

function parseRGB(str: string): { r: number; g: number; b: number } {
  if (!str) return { r: 255, g: 255, b: 255 };
  const m = str.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const [r, g, b] = m[1].split(",").map((n) => parseInt(n.trim(), 10));
    return { r, g, b };
  }
  let hex = str.replace(/^#/, "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length >= 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return { r: 255, g: 255, b: 255 };
}

export interface WaveArcsProps {
  /** Canvas backdrop colour behind the arcs. */
  backgroundColor?: string;
  /** Colour of the arc lines. */
  lineColor?: string;
  /** Stroke thickness of each arc line. */
  lineWidth?: number;
  /** How many arc lines are drawn across the canvas. */
  lineCount?: number;
  /** How fast the arcs sweep. */
  speed?: number;
  /** Brightness falloff of the lines, i.e. the glow. */
  glow?: number;
  /** Whether arcs bend to follow the pointer's vertical position. */
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
}

export default function WaveArcs({
  backgroundColor = "#0A0A0A",
  lineColor = "rgb(255, 255, 255)",
  lineWidth = 1.5,
  lineCount = 76,
  speed = 6,
  glow = 10,
  interactive = true,
  className = "",
  style,
}: WaveArcsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const containerEl = containerRef.current;
    const canvasEl = canvasRef.current;
    if (!containerEl || !canvasEl) return;
    const context = canvasEl.getContext("2d", { alpha: false });
    if (!context) return;
    const container: HTMLDivElement = containerEl;
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context;

    const line = parseRGB(lineColor);

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let phase = 0;
    let visible = true;
    let mouseY = 0;
    let targetY = 0;
    let pointerSeen = false;

    // Stroke colours differ only in alpha, and canvas composites alpha at 8
    // bits, so there are at most 256 distinct strings. Building them on demand
    // and keeping them costs a few dozen bytes and removes an interpolated
    // string per visible arc per frame.
    const strokeCache = new Array<string | undefined>(256);
    const strokeFor = (level: number): string => {
      const cached = strokeCache[level];
      if (cached !== undefined) return cached;
      const made = `rgba(${line.r}, ${line.g}, ${line.b}, ${level / 255})`;
      strokeCache[level] = made;
      return made;
    };

    function setup() {
      const rect = container.getBoundingClientRect();
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      dpr = resolveBufferRatio(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Re-centre the fan on every measurement until the pointer has actually
      // been somewhere. The old test was `if (!targetY)`, which reads a
      // container measured at 0x0 as "already centred at 0" and then never
      // corrects it, and which also re-centres mid-hover whenever the pointer
      // sits exactly on the top edge.
      if (!pointerSeen) {
        targetY = height / 2;
        mouseY = height / 2;
      }
    }

    function draw() {
      // Nothing meaningful fits in a sub-pixel box, and `map()` over a zero
      // height divides by zero: the resulting NaN slips past `level <= 0` and
      // runs the whole arc loop to build empty paths. A hidden tab or a
      // collapsed panel is exactly that box.
      if (width < 1 || height < 1) return;

      mouseY += (targetY - mouseY) * 0.1;

      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);

      const isMobile = width < 768;

      // An arc lights only where |tan(ang) - f| * height exceeds u * 20 / 275,
      // i.e. where |tan(ang) - f| > 4000 / (glow * height). Low values of
      // `glow` therefore light only the arcs nearest vertical: about 3 of 46 at
      // glow = 2 on the 190 px card, about 13 at the default 10.
      //
      // This used to be floored at `4000 / (4 * height)`, which is the one
      // thing that must not happen to a control: the floor is a function of the
      // container, so one saved value drew three different pictures across the
      // three boxes this effect renders in — 190 px on the card, 160 px in the
      // operator's preview, and 73-113 px in the effect picker, where below
      // 100 px even the default was being clamped. The stated justification does not hold
      // either: `level <= 0` skips straight past the two stroked 60+ segment
      // paths, so an unlit arc costs a `tan` and two `map`s, not a drawn arc.
      // The sparse end of the range is a look, not a leak. What it is not is a
      // look worth offering, so the catalog slider now starts at 4 — the loss
      // is visible in the panel instead of silently applied here.
      const u = 55000 / Math.max(glow, 1);

      ctx.save();
      ctx.lineWidth = lineWidth;
      ctx.translate(width / 2, height + (isMobile ? 60 : 40));

      const f = interactive ? map(mouseY, 0, height, 1.2, -1.2) : 0;
      const clamped = Math.max(320, Math.min(1440, width));
      const rate = map(clamped, 320, 1440, 0.002, 5e-4) * (speed / 5);
      const p = phase * rate;
      const h = width / 2;
      const count = isMobile ? Math.round(lineCount * 0.6) : lineCount;

      for (let k = 0; k < count; k++) {
        let ang = map(k, 0, count, 0, Math.PI) + p;
        ang %= Math.PI;
        const l = (Math.tan(ang) - f) * height;
        const a = Math.abs(l) / 2;
        const yCenter = -height / 2 + l / 2;
        const level = Math.round(Math.max(0, Math.min(255, map(Math.abs(l), 0, u, -20, 255))));
        if (level <= 0) continue;

        ctx.strokeStyle = strokeFor(level);

        if (a > 499999.5) {
          ctx.beginPath();
          ctx.moveTo(-h, -height / 2);
          ctx.lineTo(h, -height / 2);
          ctx.stroke();
          continue;
        }

        const c2 = Math.acos(Math.min(1, (h + 50) / a));
        const segTotal = Math.max(Math.ceil(a / 120), 200);
        // The two spans are fixed, so they are unrolled rather than rebuilt as
        // a fresh array of fresh tuples for every arc of every frame.
        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const start = sIdx === 0 ? c2 : Math.PI + c2;
          const end = sIdx === 0 ? Math.PI - c2 : TWO_PI - c2;
          const span = end - start;
          const n3 = Math.max(Math.ceil((span / TWO_PI) * segTotal), 60);
          const step = span / n3;
          ctx.beginPath();
          for (let s = 0; s <= n3; s++) {
            const aa = start + step * s;
            const xx = Math.cos(aa) * a;
            const yy = yCenter + Math.sin(aa) * a;
            if (s === 0) ctx.moveTo(xx, yy);
            else ctx.lineTo(xx, yy);
          }
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    function loop(time: number) {
      const dt = last ? Math.min(time - last, 100) : REF_FRAME_MS;
      last = time;
      phase += dt / REF_FRAME_MS;
      draw();
      raf = requestAnimationFrame(loop);
    }

    function start() {
      if (raf || !visible) return;
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function onPointerMove(ev: PointerEvent) {
      const rect = container.getBoundingClientRect();
      pointerSeen = true;
      targetY = ev.clientY - rect.top;
    }
    function onPointerLeave() {
      // Back to centre, and back to following the box: a resize after the
      // pointer has gone should re-centre against the new height, not keep half
      // of the old one.
      pointerSeen = false;
      targetY = height / 2;
    }

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
        if (visible) start();
        else stop();
      },
      { threshold: 0 }
    );

    const ro = new ResizeObserver(() => setup());

    setup();
    io.observe(container);
    ro.observe(container);
    if (interactive) {
      container.addEventListener("pointermove", onPointerMove, { passive: true });
      container.addEventListener("pointerleave", onPointerLeave, { passive: true });
    }
    start();

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [backgroundColor, lineColor, lineWidth, lineCount, speed, glow, interactive]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={style}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
