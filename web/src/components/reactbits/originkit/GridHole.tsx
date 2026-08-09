import { useEffect, useRef, type CSSProperties } from "react";

import { resolveBufferRatio } from '../render-scale';

/**
 * Grid Hole — Originkit `grid-hole`, ported to the card-effect shape.
 *
 * Canvas 2D plus an offscreen 2D buffer: concentric ellipses tween from a wide
 * disc down into a point, radial lines are pre-stroked once per resize into the
 * buffer, and particles drift up into the funnel's mouth.
 *
 * Two substantive changes from the capture, both noted in the port report:
 *
 * 1. The original stepped `disc.p` and `particle.y` by a fixed amount per rAF
 *    callback with no clock anywhere, so it ran at double speed on a 120 Hz
 *    display. Every step is now scaled by elapsed time against a 60 Hz
 *    reference, which leaves the 60 Hz look identical and makes 120 Hz match.
 * 2. `stateRef` was a single `any`. The state is now explicit types, which also
 *    surfaced that a `discs` value below 2 left the clip disc unassigned and
 *    threw; it now falls back to the last disc.
 */

const REF_FRAME_MS = 1000 / 60;

function toRGB(color: string): [number, number, number] {
  if (typeof color === "string") {
    if (color.startsWith("#")) {
      let hex = color.slice(1);
      if (hex.length === 3)
        hex = hex
          .split("")
          .map((c) => c + c)
          .join("");
      const n = parseInt(hex.slice(0, 6), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map((s) => parseFloat(s));
      return [p[0] || 0, p[1] || 0, p[2] || 0];
    }
  }
  return [255, 255, 255];
}

interface Disc {
  p: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

interface Particle {
  x: number;
  sx: number;
  dx: number;
  y: number;
  vy: number;
  p: number;
  r: number;
  c: string;
}

interface ParticleArea {
  sx: number;
  sw: number;
  ex: number;
  ew: number;
  h: number;
}

export interface GridHoleProps {
  /** How fast the grid collapses and particles flow into the centre. */
  speed?: number;
  /** Colour of the grid lines that make up the funnel. */
  strokeColor?: string;
  /** Thickness of the grid lines in pixels. */
  lineWidth?: number;
  /** How many radial lines form the grid wireframe. */
  lines?: number;
  /** How many concentric rings shape the funnel's depth. */
  discs?: number;
  /** Toggles the drifting particle stream. */
  particles?: boolean;
  /** Colour of the particles flowing into the hole. */
  particleColor?: string;
  /** How many particles animate at once. */
  particleCount?: number;
  /** Toggles the coloured glow at the core. */
  glow?: boolean;
  /** Colour of the core glow. */
  glowColor?: string;
  /** Backdrop the funnel is cut out of; the vignette fades to this too. */
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

export default function GridHole({
  speed = 50,
  strokeColor = "#FFFFFF",
  lineWidth = 1,
  lines = 80,
  discs = 80,
  particles = true,
  particleColor = "#FFFFFF",
  particleCount = 300,
  glow = true,
  glowColor = "#FFFFFF",
  backgroundColor = "#000000",
  className = "",
  style,
}: GridHoleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const containerEl = containerRef.current;
    const canvasEl = canvasRef.current;
    if (!containerEl || !canvasEl) return;
    const context = canvasEl.getContext("2d");
    if (!context) return;
    const container: HTMLDivElement = containerEl;
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context;

    const particleRGB = toRGB(particleColor);
    const discInc = (speed / 100) * 0.002;
    const vyScale = speed / 50;
    const discCount = Math.max(1, Math.round(discs));
    const lineCount = Math.max(1, Math.round(lines));

    let raf = 0;
    let last = 0;
    let width = 0;
    let height = 0;
    let dpi = 1;

    let discList: Disc[] = [];
    let lineList: Point[][] = [];
    let particleList: Particle[] = [];
    let startDisc: Disc = { p: 0, x: 0, y: 0, w: 0, h: 0 };
    let endDisc: Disc = { p: 1, x: 0, y: 0, w: 0, h: 0 };
    let clipDisc: Disc | null = null;
    let clipPath: Path2D | null = null;
    let linesCanvas: HTMLCanvasElement | null = null;
    let area: ParticleArea = { sx: 0, sw: 0, ex: 0, ew: 0, h: 0 };

    const linear = (p: number) => p;
    const easeInExpo = (p: number) => (p === 0 ? 0 : Math.pow(2, 10 * (p - 1)));

    function tweenValue(start: number, end: number, p: number, ease: "inExpo" | null = null) {
      const delta = end - start;
      const easeFn = ease === "inExpo" ? easeInExpo : linear;
      return start + delta * easeFn(p);
    }

    function tweenDisc(disc: Disc) {
      disc.x = tweenValue(startDisc.x, endDisc.x, disc.p);
      disc.y = tweenValue(startDisc.y, endDisc.y, disc.p, "inExpo");
      disc.w = tweenValue(startDisc.w, endDisc.w, disc.p);
      disc.h = tweenValue(startDisc.h, endDisc.h, disc.p);
    }

    function setSize() {
      const rect = container.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      dpi = resolveBufferRatio(width, height, Math.min(window.devicePixelRatio || 1, 2));
      canvas.width = Math.max(1, Math.round(width * dpi));
      canvas.height = Math.max(1, Math.round(height * dpi));
    }

    function setDiscs() {
      discList = [];
      clipDisc = null;
      clipPath = null;
      if (!width || !height) return;

      startDisc = { p: 0, x: width * 0.5, y: height * 0.45, w: width * 0.75, h: height * 0.7 };
      endDisc = { p: 1, x: width * 0.5, y: height * 0.95, w: 0, h: 0 };

      let prevBottom = height;
      for (let i = 0; i < discCount; i++) {
        const p = i / discCount;
        const disc: Disc = { p, x: 0, y: 0, w: 0, h: 0 };
        tweenDisc(disc);
        const bottom = disc.y + disc.h;
        if (bottom <= prevBottom) {
          clipDisc = { ...disc };
        }
        prevBottom = bottom;
        discList.push(disc);
      }

      // With very few discs the loop above can leave the clip unset; the source
      // then dereferenced undefined. Fall back to the innermost disc.
      if (!clipDisc && discList.length) clipDisc = { ...discList[discList.length - 1] };
      if (!clipDisc) return;

      const path = new Path2D();
      path.ellipse(clipDisc.x, clipDisc.y, clipDisc.w, clipDisc.h, 0, 0, Math.PI * 2);
      path.rect(clipDisc.x - clipDisc.w, 0, clipDisc.w * 2, clipDisc.y);
      clipPath = path;
    }

    function setLines() {
      lineList = [];
      linesCanvas = null;
      if (!width || !height || !clipPath) return;

      const linesAngle = (Math.PI * 2) / lineCount;
      for (let i = 0; i < lineCount; i++) lineList.push([]);
      for (const disc of discList) {
        for (let i = 0; i < lineCount; i++) {
          const angle = i * linesAngle;
          lineList[i].push({
            x: disc.x + Math.cos(angle) * disc.w,
            y: disc.y + Math.sin(angle) * disc.h,
          });
        }
      }

      const offCanvas = document.createElement("canvas");
      offCanvas.width = Math.max(1, Math.round(width * dpi));
      offCanvas.height = Math.max(1, Math.round(height * dpi));
      const offCtx = offCanvas.getContext("2d");
      if (!offCtx) return;
      const path = clipPath;

      // Hit-tested before the dpi scale: the points are in CSS pixels.
      offCtx.lineWidth = 1;
      const enters = lineList.map((line) => {
        for (let j = 1; j < line.length; j++) {
          const p = line[j];
          if (offCtx.isPointInPath(path, p.x, p.y) || offCtx.isPointInStroke(path, p.x, p.y)) {
            return j;
          }
        }
        return -1;
      });

      offCtx.scale(dpi, dpi);
      offCtx.strokeStyle = strokeColor;
      offCtx.lineWidth = lineWidth;
      offCtx.lineJoin = "round";
      offCtx.lineCap = "round";

      const strokePolyline = (points: Point[]) => {
        if (points.length < 2) return;
        offCtx.beginPath();
        offCtx.moveTo(points[0].x, points[0].y);
        for (let j = 1; j < points.length; j++) offCtx.lineTo(points[j].x, points[j].y);
        offCtx.stroke();
      };

      lineList.forEach((line, i) => {
        const enter = enters[i];
        if (enter === -1) {
          strokePolyline(line);
          return;
        }
        strokePolyline(line.slice(0, enter + 1));
        offCtx.save();
        offCtx.clip(path);
        strokePolyline(line.slice(enter));
        offCtx.restore();
      });

      linesCanvas = offCanvas;
    }

    function initParticle(start = false): Particle {
      const sx = area.sx + area.sw * Math.random();
      const ex = area.ex + area.ew * Math.random();
      const dx = ex - sx;
      const y = start ? area.h * Math.random() : area.h;
      const r = 0.5 + Math.random() * 4;
      const vy = 0.5 + Math.random();
      return {
        x: sx,
        sx,
        dx,
        y,
        vy,
        p: 0,
        r,
        c: `rgba(${particleRGB[0]}, ${particleRGB[1]}, ${particleRGB[2]}, ${Math.random()})`,
      };
    }

    function setParticles() {
      particleList = [];
      if (!particles || !width || !height || !clipDisc) return;
      const sw = clipDisc.w * 0.5;
      const ew = clipDisc.w * 2;
      area = { sw, ew, h: height * 0.85, sx: (width - sw) / 2, ex: (width - ew) / 2 };
      for (let i = 0; i < particleCount; i++) particleList.push(initParticle(true));
    }

    function moveDiscs(frames: number) {
      const inc = discInc * frames;
      for (const disc of discList) {
        disc.p = (disc.p + inc) % 1;
        tweenDisc(disc);
      }
    }

    function moveParticles(frames: number) {
      if (!area.h) return;
      for (let i = 0; i < particleList.length; i++) {
        const particle = particleList[i];
        particle.p = 1 - particle.y / area.h;
        particle.x = particle.sx + particle.dx * particle.p;
        particle.y -= particle.vy * vyScale * frames;
        if (particle.y < 0) particleList[i] = initParticle();
      }
    }

    function drawDiscs() {
      if (!clipDisc || !clipPath) return;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.ellipse(startDisc.x, startDisc.y, startDisc.w, startDisc.h, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.closePath();
      discList.forEach((disc, i) => {
        if (i % 5 !== 0) return;
        const inner = disc.w < (clipDisc as Disc).w - 5;
        if (inner) {
          ctx.save();
          ctx.clip(clipPath as Path2D);
        }
        ctx.beginPath();
        ctx.ellipse(disc.x, disc.y, disc.w, disc.h, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.closePath();
        if (inner) ctx.restore();
      });
    }

    function drawLines() {
      if (!linesCanvas) return;
      ctx.drawImage(linesCanvas, 0, 0, width, height);
    }

    function drawParticles() {
      if (!clipPath) return;
      ctx.save();
      ctx.clip(clipPath);
      for (const particle of particleList) {
        ctx.fillStyle = particle.c;
        ctx.beginPath();
        ctx.arc(particle.x + particle.r / 2, particle.y + particle.r / 2, particle.r / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    function tick(time: number) {
      const dt = last ? Math.min(time - last, 100) : REF_FRAME_MS;
      last = time;
      const frames = dt / REF_FRAME_MS;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpi, dpi);
      if (clipPath) {
        moveDiscs(frames);
        moveParticles(frames);
        drawDiscs();
        drawLines();
        drawParticles();
      }
      ctx.restore();
      raf = requestAnimationFrame(tick);
    }

    function build() {
      setSize();
      setDiscs();
      setLines();
      setParticles();
    }

    build();
    raf = requestAnimationFrame(tick);

    let built = `${Math.round(width)}x${Math.round(height)}`;
    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
      if (size === built) return;
      built = size;
      build();
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      linesCanvas = null;
    };
    // `backgroundColor` is deliberately absent, like `glow` and `glowColor`:
    // all three are read only by the JSX below, never by the effect. Listing it
    // meant every step of the operator's colour picker tore the effect down and
    // ran `build()` again — and `setLines()` inside it hit-tests every point of
    // every radial line against the clip path (up to 14,400 `isPointInPath` /
    // `isPointInStroke` calls) and allocates a full-DPR offscreen canvas. That
    // ran synchronously on each `pointermove` over the swatch.
  }, [speed, strokeColor, lineWidth, lines, discs, particles, particleColor, particleCount]);

  return (
    <div
      ref={containerRef}
      style={{ background: backgroundColor, ...style }}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
    >
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: "140%",
          height: "140%",
          transform: "translate3d(-50%, -50%, 0)",
          background: `radial-gradient(ellipse at 50% 55%, transparent 10%, ${backgroundColor} 50%)`,
          pointerEvents: "none",
        }}
      />
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ position: "absolute", inset: 0, opacity: 0.2 }}
      />
      {glow && (
        <div
          style={{
            position: "absolute",
            zIndex: 5,
            top: "50%",
            left: "50%",
            width: "100%",
            height: "100%",
            transform: "translate3d(-50%, -50%, 0)",
            background: `radial-gradient(ellipse at 50% 75%, ${glowColor} 20%, transparent 75%)`,
            mixBlendMode: "overlay",
            pointerEvents: "none",
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          zIndex: 7,
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          background: "repeating-linear-gradient(transparent, transparent 1px, #ffffff 1px, #ffffff 2px)",
          mixBlendMode: "overlay",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
