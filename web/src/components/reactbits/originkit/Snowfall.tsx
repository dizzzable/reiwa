import { useEffect, useRef, type CSSProperties } from "react";

/**
 * Snowfall — drifting canvas snow.
 *
 * Ported from the Originkit `snowfall` capture. Canvas 2D, self-animating:
 * the source starts a `requestAnimationFrame` loop unconditionally and reads
 * no pointer, so no autopilot is required.
 *
 * Defaults below are the source's own `COMPONENT_DEFAULTS`, which it spreads
 * *under* incoming props before destructuring. The destructuring defaults in
 * the capture (`count = 632`, `sizeMin = 2`, `sizeMax = 2.5`, `wind = -1`) are
 * therefore unreachable for an omitted prop, and the site's published props
 * table — which lists 632 — describes a value the component never uses.
 */
export interface SnowfallProps {
  /** Number of flakes in the field; higher is denser. */
  count?: number;
  /** Slowest fall speed a flake can be assigned, px/frame. */
  speedMin?: number;
  /** Fastest fall speed a flake can be assigned, px/frame. */
  speedMax?: number;
  /** Constant horizontal drift; negative blows left, positive right. */
  wind?: number;
  /** Random per-flake spread added to the horizontal drift. */
  windVariation?: number;
  /** Smallest flake radius in px. */
  sizeMin?: number;
  /** Largest flake radius in px. */
  sizeMax?: number;
  /** Lowest per-flake opacity, percent. */
  opacityMin?: number;
  /** Highest per-flake opacity, percent. */
  opacityMax?: number;
  /** Fall direction. */
  direction?: "down" | "up";
  /** Fill colour of the flakes. */
  color?: string;
  className?: string;
  style?: CSSProperties;
}

interface Flake {
  x: number;
  y: number;
  r: number;
  vy: number;
  vx: number;
  phase: number;
  sway: number;
  alpha: number;
}

export default function Snowfall({
  count = 160,
  speedMin = 0.6,
  speedMax = 2.4,
  wind = 0,
  windVariation = 0.8,
  sizeMin = 1,
  sizeMax = 4,
  opacityMin = 30,
  opacityMax = 90,
  direction = "down",
  color = "#ffffff",
  className = "",
  style,
}: SnowfallProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live config read by the loop so tweaking colour or wind does not re-scatter
  // the snow.
  const cfg = useRef({ color, wind, windVariation });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    cfg.current = { color, wind, windVariation };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const cv: HTMLCanvasElement = canvas;
    const box: HTMLDivElement = container;
    const g: CanvasRenderingContext2D = context;

    let raf = 0;
    let width = 0;
    let height = 0;
    let flakes: Flake[] = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const dirSign = direction === "up" ? -1 : 1;
    const speedLo = Math.min(speedMin, speedMax);
    const speedHi = Math.max(speedMin, speedMax);
    const sizeLo = Math.min(sizeMin, sizeMax);
    const sizeHi = Math.max(sizeMin, sizeMax);
    const alphaLo = Math.min(opacityMin, opacityMax) / 100;
    const alphaHi = Math.max(opacityMin, opacityMax) / 100;

    function spawn(w: number, h: number): Flake {
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r: rand(sizeLo, sizeHi),
        vy: rand(speedLo, speedHi),
        vx: rand(-1, 1),
        phase: Math.random() * Math.PI * 2,
        sway: rand(0.2, 0.9),
        alpha: rand(alphaLo, alphaHi),
      };
    }

    function measure(entry?: ResizeObserverEntry) {
      const rect = entry?.contentRect ?? box.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width) || 1);
      const h = Math.max(1, Math.floor(rect.height) || 1);
      const prevW = width;
      const prevH = height;
      width = w;
      height = h;
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      const n = Math.max(0, Math.round(count));
      if (flakes.length !== n) {
        flakes = new Array(n);
        for (let i = 0; i < n; i++) flakes[i] = spawn(w, h);
        return;
      }
      // Carry the existing field across a resize instead of re-scattering it —
      // the card changes size during layout, and a full re-seed reads as the
      // snow teleporting.
      const sx = prevW > 0 ? w / prevW : 1;
      const sy = prevH > 0 ? h / prevH : 1;
      for (let i = 0; i < flakes.length; i++) {
        flakes[i].x *= sx;
        flakes[i].y *= sy;
      }
    }

    function draw() {
      g.clearRect(0, 0, width, height);
      g.fillStyle = cfg.current.color;
      for (let i = 0; i < flakes.length; i++) {
        const f = flakes[i];
        g.globalAlpha = f.alpha;
        g.beginPath();
        g.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    function loop(t: number) {
      const { wind: windBase, windVariation: windSpread } = cfg.current;
      for (let i = 0; i < flakes.length; i++) {
        const f = flakes[i];
        f.y += f.vy * dirSign;
        f.x += windBase + f.vx * windSpread + Math.sin(t * 0.0012 + f.phase) * f.sway;
        if (dirSign > 0 && f.y - f.r > height) {
          f.y = -f.r;
          f.x = Math.random() * width;
        } else if (dirSign < 0 && f.y + f.r < 0) {
          f.y = height + f.r;
          f.x = Math.random() * width;
        }
        if (f.x < -f.r) f.x = width + f.r;
        else if (f.x > width + f.r) f.x = -f.r;
      }
      draw();
      raf = requestAnimationFrame(loop);
    }

    measure();
    draw();
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver((entries) => {
      measure(entries[0]);
      draw();
    });
    ro.observe(box);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [count, speedMin, speedMax, sizeMin, sizeMax, opacityMin, opacityMax, direction]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
      style={style}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
