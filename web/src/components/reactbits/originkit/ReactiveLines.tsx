import { useEffect, useRef, type CSSProperties } from "react";

import { resolveBufferRatio } from '../render-scale';

/**
 * Reactive Lines — Originkit `reactive-lines`, ported to the card-effect shape.
 *
 * Canvas 2D. A fan of curved lines swung between a fixed anchor and a spread of
 * end points, with a travelling bulge along each curve.
 *
 * WHY IT LOOKED BROKEN, and the fix
 * ---------------------------------
 * The loop does start — the IntersectionObserver starts it — but the file
 * contains no time term of any kind. Both animated quantities, the line count
 * and the bulge bias, are lerps toward targets derived from the cursor, and the
 * cursor is seeded to the centre of the box. With nothing to move the targets
 * the lerps converge in a second or two and the picture is a still image after
 * that. Its only input was `mousemove` on `document`, which touch never fires.
 *
 * The fix drives the cursor target from elapsed time; the existing 0.05 and 0.1
 * lerps then do the easing for free. The `document` listener is gone — the
 * house rule forbids it and it fought every other card on the page — replaced
 * by `pointermove` / `pointerleave` on this component's own container, which
 * also made the original's `scroll` listener (there only to keep a cached
 * container rect valid) unnecessary. A real pointer takes over within a few
 * frames and hands back after a dwell plus a two-second ease.
 *
 * The root is `position: absolute; inset: 0` as in the capture, so it still
 * needs a positioned parent — which the card-effect layer is.
 */

type Vec = { x: number; y: number };

const vec = (x: number, y: number): Vec => ({ x, y });
const vecAdd = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const vecSub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const vecMult = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
const vecLerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, mn: number, mx: number) => Math.max(mn, Math.min(mx, v));
const map = (v: number, a: number, b: number, c: number, d: number) => ((v - a) / (b - a)) * (d - c) + c;

function toRGB(str: string): { r: number; g: number; b: number } {
  if (str) {
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map((s) => parseFloat(s));
      return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0 };
    }
    const hex = str.replace("#", "");
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
  }
  return { r: 10, g: 10, b: 10 };
}

const AUTOPILOT_DWELL_MS = 600;
const AUTOPILOT_IN_TAU = 0.9;
const AUTOPILOT_OUT_TAU = 0.12;
/**
 * A `pointermove` with no `pointerleave` after it latches the blend on the last
 * touched point for the life of the mount — the webview swallowing a swipe, or
 * a sheet dismissed mid-touch, both do exactly that, and toggling a control off
 * unbinds the listener that would have cleared it. Treat a pointer that has not
 * moved for this long as gone.
 */
const POINTER_IDLE_MS = 3000;

/**
 * Synthetic cursor. Two sine terms per axis with periods of roughly 27 s / 12 s
 * across and 41 s / 17 s down, which share no small common multiple, so the
 * walk does not visibly retrace. The vertical centre sits above the middle of
 * the box because the vertical axis sets the line count: this keeps the fan
 * mostly dense and lets it open up now and then rather than the reverse.
 */
function autoPointX(t: number) {
  return 0.5 + 0.4 * Math.sin(t * 0.233) + 0.1 * Math.sin(t * 0.52 + 0.7);
}
function autoPointY(t: number) {
  return 0.55 + 0.3 * Math.sin(t * 0.153 + 1.9) + 0.1 * Math.sin(t * 0.37 + 2.6);
}

export interface ReactiveLinesProps {
  /** Canvas background colour the lines are drawn over. */
  backgroundColor?: string;
  /** Colour of the animated lines. */
  lineColor?: string;
  /** Stroke thickness of each line in pixels. */
  lineWidth?: number;
  /** Fewest lines drawn, when the cursor is near the top. */
  minLines?: number;
  /** Most lines drawn, when the cursor is near the bottom. */
  maxLines?: number;
  /** Soft vignette fading the edges toward the background colour. */
  fade?: boolean;
  /** How far the vignette reaches and how strong it gets. */
  fadeIntensity?: number;
  /** Drive a synthetic cursor when no real one is present. */
  autoplay?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface LiveProps {
  backgroundColor: string;
  lineColor: string;
  lineWidth: number;
  minLines: number;
  maxLines: number;
  fade: boolean;
  fadeIntensity: number;
  autoplay: boolean;
}

export default function ReactiveLines({
  backgroundColor = "rgb(10, 10, 10)",
  lineColor = "rgba(255, 255, 255, 1)",
  lineWidth = 1,
  minLines = 2,
  maxLines = 45,
  fade = false,
  fadeIntensity = 15,
  autoplay = true,
  className = "",
  style,
}: ReactiveLinesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef<LiveProps>({
    backgroundColor,
    lineColor,
    lineWidth,
    minLines,
    maxLines,
    fade,
    fadeIntensity,
    autoplay,
  });

  useEffect(() => {
    propsRef.current = {
      backgroundColor,
      lineColor,
      lineWidth,
      minLines,
      maxLines,
      fade,
      fadeIntensity,
      autoplay,
    };
  }, [backgroundColor, lineColor, lineWidth, minLines, maxLines, fade, fadeIntensity, autoplay]);

  useEffect(() => {
    const containerEl = containerRef.current;
    const canvasEl = canvasRef.current;
    if (!containerEl || !canvasEl) return;
    const context = canvasEl.getContext("2d", { alpha: false });
    if (!context) return;
    const container: HTMLDivElement = containerEl;
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context;

    let width = 0;
    let height = 0;
    let raf = 0;
    let visible = true;
    let startTime = 0;
    let lastTime = 0;

    const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
    const cfg = { linesNum: 40, bias: 0.5 };

    let blend = 1;
    let pointerActive = false;
    let leftAt = 0;
    let movedAt = 0;
    let pointerX = 0;
    let pointerY = 0;
    let seeded = false;

    function setup() {
      const rect = container.getBoundingClientRect();
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      const dpr = resolveBufferRatio(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Seed once only: re-seeding on every resize would jolt the line count.
      if (!seeded && width > 0 && height > 0) {
        seeded = true;
        mouse.targetX = width / 2;
        mouse.targetY = height / 2;
        mouse.x = width / 2;
        mouse.y = height / 2;
        pointerX = width / 2;
        pointerY = height / 2;
      }
    }

    /** One curve from `from` to `to`, bulged toward `disp`. */
    function strokeCurve(from: Vec, to: Vec, disp: Vec, bias: number, power: number) {
      const mid = vecLerp(from, to, 0.5);
      const push = vecSub(disp, mid);
      ctx.beginPath();
      for (let i = 0; i <= 50; i++) {
        const o = i / 50;
        const base = vecLerp(from, to, o);
        const amount = 2 * Math.pow(o, power * (1 - bias) * 2) * Math.pow(1 - o, power * bias * 2);
        const cv = vecAdd(base, vecMult(push, amount));
        if (i === 0) ctx.moveTo(cv.x, cv.y);
        else ctx.lineTo(cv.x, cv.y);
      }
      ctx.stroke();
    }

    function draw(time: number) {
      const p = propsRef.current;
      if (!startTime) startTime = time;
      const dtSec = lastTime ? Math.min(time - lastTime, 100) / 1000 : 1 / 60;
      lastTime = time;
      const t = (time - startTime) / 1000;

      // A box measured at zero — mounted before layout, a collapsed parent, or a
      // ResizeObserver frame passing through 0 as the Telegram address bar
      // collapses — makes `map(mouse.y, 0, 0, …)` a 0/0. That NaN survives
      // `clamp` and then lives in `cfg.linesNum` forever, because every later
      // frame lerps toward it: the fan is gone for the life of the mount even
      // once the size comes back. Nothing here is worth drawing at zero size, so
      // skip the frame whole and leave every accumulator as it was.
      if (!(width > 0) || !(height > 0)) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // Hand-off between the real pointer and the synthetic one. A pointer that
      // stopped reporting without ever leaving is treated as gone, so the
      // autopilot always comes back.
      if (pointerActive && time - movedAt > POINTER_IDLE_MS) {
        pointerActive = false;
        leftAt = time;
      }
      const dwelling = !pointerActive && leftAt > 0 && time - leftAt < AUTOPILOT_DWELL_MS;
      const wantsAuto = p.autoplay && !pointerActive && !dwelling;
      const goal = wantsAuto ? 1 : 0;
      const tau = wantsAuto ? AUTOPILOT_IN_TAU : AUTOPILOT_OUT_TAU;
      blend += (goal - blend) * (1 - Math.exp(-dtSec / tau));

      if (p.autoplay) {
        mouse.targetX = lerp(pointerX, autoPointX(t) * width, blend);
        mouse.targetY = lerp(pointerY, autoPointY(t) * height, blend);
      } else if (pointerActive) {
        mouse.targetX = pointerX;
        mouse.targetY = pointerY;
      }

      mouse.x = mouse.x + (mouse.targetX - mouse.x) * 0.05;
      mouse.y = mouse.y + (mouse.targetY - mouse.y) * 0.1;

      const r = width;
      const n = height;

      ctx.fillStyle = p.backgroundColor;
      ctx.fillRect(0, 0, r, n);

      ctx.save();
      ctx.translate(r / 2, n / 2);

      const narrow = r < 500;
      const u = narrow ? 0.8 * n : 0;
      const power = narrow ? 1.5 : 0.7;

      const anchor = vec(r, -(1.1 * n) + u);
      const low = vec(0, 2 * n);
      const high = vec(-r, -n + u);

      const lo = Math.min(p.minLines, p.maxLines);
      const hi = Math.max(p.minLines, p.maxLines);
      // Both accumulators are only ever fed a finite target. A control that
      // arrived as a non-number would otherwise poison them the same way a
      // zero-sized box did, and a lerp toward NaN never comes back.
      const wantLines = clamp(map(mouse.y, 0, n, lo, hi), lo, hi);
      if (Number.isFinite(wantLines)) cfg.linesNum = lerp(cfg.linesNum, wantLines, 0.1);
      if (!Number.isFinite(cfg.linesNum)) cfg.linesNum = 40;

      const wantBias = clamp(map(mouse.x, 0, r, 0.6, 0.4), 0.4, 0.6);
      if (Number.isFinite(wantBias)) cfg.bias = lerp(cfg.bias, wantBias, 0.05);
      if (!Number.isFinite(cfg.bias)) cfg.bias = 0.5;

      ctx.strokeStyle = p.lineColor;
      ctx.lineWidth = p.lineWidth;

      // Guarded: an operator can set both line counts to 1, which divided by zero.
      const denom = Math.max(1e-6, cfg.linesNum - 1);
      for (let i = 0; i < cfg.linesNum; i++) {
        const k = i / denom;
        const lineEnd = vec(lerp(low.x, high.x, 1 - k * k), lerp(low.y, high.y, 1 - k * k));
        const mid = vecAdd(vecMult(anchor, 0.5), vecMult(lineEnd, 0.5));
        const dispTarget = vecMult(vecAdd(low, mid), 0.5);
        strokeCurve(anchor, lineEnd, dispTarget, cfg.bias, power);
      }

      ctx.restore();

      if (p.fade) {
        const bg = toRGB(p.backgroundColor);
        const rgba = (alpha: number) => `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${alpha})`;
        const inner = clamp(map(p.fadeIntensity, 1, 50, 0.82, 0.25), 0.25, 0.82);
        const maxA = clamp(map(p.fadeIntensity, 1, 50, 0.35, 0.9), 0.35, 0.9);
        ctx.save();
        const x = Math.max(r, n) / 2;
        ctx.translate(r / 2, n / 2);
        ctx.scale(r / (2 * x), n / (2 * x));
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, x);
        grad.addColorStop(0, rgba(0));
        grad.addColorStop(inner, rgba(0));
        grad.addColorStop(lerp(inner, 1, 0.5), rgba(maxA * 0.3));
        grad.addColorStop(lerp(inner, 1, 0.8), rgba(maxA * 0.7));
        grad.addColorStop(1, rgba(maxA));
        ctx.fillStyle = grad;
        ctx.fillRect(-x, -x, 2 * x, 2 * x);
        ctx.restore();
      }

      raf = requestAnimationFrame(draw);
    }

    function start() {
      if (raf || !visible) return;
      lastTime = 0;
      raf = requestAnimationFrame(draw);
    }
    function stop() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function onMove(e: PointerEvent) {
      const rect = container.getBoundingClientRect();
      pointerX = e.clientX - rect.left;
      pointerY = e.clientY - rect.top;
      pointerActive = true;
      movedAt = performance.now();
      leftAt = 0;
    }
    function onLeave() {
      if (!pointerActive) return;
      pointerActive = false;
      leftAt = performance.now();
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
    container.addEventListener("pointermove", onMove, { passive: true });
    container.addEventListener("pointerleave", onLeave, { passive: true });
    container.addEventListener("pointercancel", onLeave, { passive: true });
    start();

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("pointercancel", onLeave);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={style}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
