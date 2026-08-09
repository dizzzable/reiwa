import { useEffect, useRef, type CSSProperties } from "react";

/**
 * BlinkingSquares — a grid of independently twinkling squares.
 *
 * Ported from the Originkit `blinkingsquares` capture. Canvas 2D.
 *
 * The twinkle is driven by elapsed time and needs no pointer, so the field is
 * never still. The cursor *halo* is the only pointer-dependent part; `autoplay`
 * walks a synthetic cursor across the box so that an operator who switches
 * `hasCursorInteraction` on still sees the halo on a device with no cursor. A
 * real pointer takes over within a few frames and the autopilot fades back in
 * about a second and a half after it leaves.
 */
export interface BlinkingSquaresProps {
  /** Cells across the long axis; higher packs in more, smaller squares. */
  gridSize?: number;
  /** Size of each square within its cell, 10..100 percent. */
  fillPercent?: number;
  /** Single colour or a multi-colour palette. */
  colorMode?: "single" | "multiple";
  /** Colour used in single mode. */
  squareColor?: string;
  /** Up to five colours cells pick from in multiple mode. */
  colors?: string[];
  /** Blink rate, 1..100. */
  twinkleSpeed?: number;
  /** Master opacity, 0..1. */
  opacity?: number;
  /** Edge the density fade runs toward. */
  fadeDirection?: "right" | "left" | "top" | "bottom" | "none";
  /** How much of the canvas the fade spans, 0..100 percent. */
  fadePercent?: number;
  /** Steepness of the fade falloff, 0..100 percent. */
  fadeIntensity?: number;
  /** Enable the cursor halo. */
  hasCursorInteraction?: boolean;
  /** Reach of the halo in px. */
  cursorRadius?: number;
  /** How strongly the halo reveals nearby squares, 1..100. */
  cursorBoost?: number;
  /**
   * Drive the halo from a synthetic cursor when no real one is present. Only
   * has any effect while `hasCursorInteraction` is on.
   */
  autoplay?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface Cell {
  phase: number;
  rate: number;
  tint: number;
}

/**
 * Milliseconds of silence after which a pointer counts as gone even though no
 * `pointerleave` ever arrived. It does not always arrive — the webview takes
 * over a swipe, a sheet is dismissed mid-touch — and the latch survives an
 * effect re-run because the flag lives in a ref: turning `hasCursorInteraction`
 * off unbinds the only listener that could ever have cleared it, so the halo
 * stays pinned to the last touched point for the life of the mount.
 */
const POINTER_IDLE_MS = 3000;

type Rgb = [number, number, number];

function parseColor(input: string): Rgb {
  if (!input) return [255, 255, 255];
  const s = input.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(",").map((v) => parseFloat(v.trim()));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return [255, 255, 255];
}

export default function BlinkingSquares({
  gridSize = 40,
  fillPercent = 70,
  colorMode = "single",
  squareColor = "#BB29FF",
  colors = ["#BB29FF", "#29D9FF", "#FF2975"],
  twinkleSpeed = 30,
  opacity = 1,
  fadeDirection = "right",
  fadePercent = 100,
  fadeIntensity = 25,
  hasCursorInteraction = false,
  cursorRadius = 140,
  cursorBoost = 60,
  autoplay = true,
  className = "",
  style,
}: BlinkingSquaresProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef({ x: -9999, y: -9999, active: false, at: 0 });
  const cellsRef = useRef<Cell[]>([]);
  const cellsKeyRef = useRef("");
  // Held outside the effect so changing a control does not jump the twinkle
  // back to phase zero.
  const startRef = useRef(performance.now());
  const blendRef = useRef(0);

  // The palette is read through a ref and the effect keys off its contents, so a
  // parent that rebuilds the array every render does not restart the loop.
  const colorsRef = useRef<string[]>(colors);
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    colorsRef.current = colors;
  });
  const colorsKey = colors.join("|");

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const box: HTMLDivElement = container;
    const cv: HTMLCanvasElement = canvas;
    const ctx: CanvasRenderingContext2D = context;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let width = 0;
    let height = 0;
    let last = 0;

    // Palette: one colour in "single" mode, up to five in "multiple".
    const palette: Rgb[] =
      colorMode === "multiple" && colorsRef.current.length > 0
        ? colorsRef.current.slice(0, 5).map(parseColor)
        : [parseColor(squareColor)];

    // Speed control is 1–100; scale to ~0.05–5 cycles/sec.
    const speed = Math.max(0, twinkleSpeed) * 0.05;
    const masterOpacity = Math.max(0, Math.min(1, opacity));
    // fillPercent is 10–100 (%); convert to a 0.1–1.0 square-size fraction.
    const fill = Math.max(0.1, Math.min(1, fillPercent / 100));
    const inset = (1 - fill) * 0.5;
    // The fade covers the far `fadePercent`% of the canvas: 0 = none,
    // 100 = a gradient across the whole canvas.
    const f = Math.max(0, Math.min(1, fadePercent / 100));
    const fStart = 1 - f;
    const noFade = f <= 0;
    // Intensity 0–100% maps to the fade curve exponent (0.2 gentle, 6 steep).
    const falloff = 0.2 + (Math.max(0, Math.min(100, fadeIntensity)) / 100) * 5.8;
    const cr = Math.max(1, cursorRadius);
    const cr2 = cr * cr;
    // Boost control is 1–100; scale to a 0.01–1.0 brightness add.
    const cb = Math.max(0, cursorBoost) / 100;

    // Cell generation: stable per (cols, rows), with a different rate and phase
    // per cell so the field never pulses in sync.
    function ensureCells(cols: number, rows: number) {
      const key = `${cols}x${rows}`;
      if (cellsKeyRef.current === key && cellsRef.current.length === cols * rows) return;
      const arr: Cell[] = new Array(cols * rows);
      for (let i = 0; i < arr.length; i++) {
        const s1 = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
        const s2 = Math.sin(i * 7.137 + 33.71) * 12345.6789;
        const s3 = Math.sin(i * 3.51 + 5.91) * 9876.54321;
        arr[i] = {
          phase: (s1 - Math.floor(s1)) * Math.PI * 2,
          // 0.6x..1.4x the base rate so cells drift apart over time.
          rate: 0.6 + (s2 - Math.floor(s2)) * 0.8,
          tint: s3 - Math.floor(s3),
        };
      }
      cellsRef.current = arr;
      cellsKeyRef.current = key;
    }

    function resize(entry?: ResizeObserverEntry) {
      const rect = entry?.contentRect ?? box.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width || box.clientWidth) || 1);
      height = Math.max(1, Math.floor(rect.height || box.clientHeight) || 1);
      cv.width = Math.floor(width * dpr);
      cv.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // cols/rows depend on size; ensureCells refills on the next frame.
      cellsKeyRef.current = "";
    }

    function draw(now: number, dt: number) {
      if (width <= 0 || height <= 0) return;

      // Square cells sized off the long axis, then the area filled with the
      // cols/rows that implies.
      const cellCount = Math.max(2, Math.floor(gridSize));
      const cellSize = Math.max(width, height) / cellCount;
      const cols = Math.max(1, Math.ceil(width / cellSize));
      const rows = Math.max(1, Math.ceil(height / cellSize));
      ensureCells(cols, rows);

      // Transparent canvas — no background fill.
      ctx.clearRect(0, 0, width, height);

      const t = (now - startRef.current) / 1000;
      const pointer = pointerRef.current;
      // A pointer that stopped reporting without ever leaving is treated as
      // gone, so the autopilot always comes back.
      if (pointer.active && now - pointer.at > POINTER_IDLE_MS) pointer.active = false;
      // Ease towards the real cursor quickly and back to the synthetic one over
      // roughly a second and a half, so the two never fight for the halo.
      const target = pointer.active ? 1 : 0;
      blendRef.current += (target - blendRef.current) * Math.min(1, dt * (pointer.active ? 6 : 0.7));
      const blend = blendRef.current;

      // Two sine terms of incommensurable periods per axis: a smooth path that
      // covers the box without ever quite repeating.
      const autoX = (0.5 + 0.32 * Math.sin(t * 0.19) + 0.13 * Math.sin(t * 0.081)) * width;
      const autoY = (0.5 + 0.29 * Math.cos(t * 0.143) + 0.12 * Math.sin(t * 0.057)) * height;
      const hasCursor = hasCursorInteraction && (pointer.active || (autoplay && blend < 1));
      const cursorX = autoplay ? autoX + (pointer.x - autoX) * blend : pointer.x;
      const cursorY = autoplay ? autoY + (pointer.y - autoY) * blend : pointer.y;

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cell = cellsRef.current[y * cols + x];
          if (!cell) continue;

          // Directional fade ramp: u runs 0->1 along the chosen axis.
          let u: number;
          switch (fadeDirection) {
            case "left":
              u = 1 - x / Math.max(1, cols - 1);
              break;
            case "top":
              u = 1 - y / Math.max(1, rows - 1);
              break;
            case "bottom":
              u = y / Math.max(1, rows - 1);
              break;
            case "none":
              u = 0;
              break;
            default:
              u = x / Math.max(1, cols - 1);
          }

          // Density envelope: 1 below fStart, 0 at the far edge, smooth between.
          let envelope: number;
          if (fadeDirection === "none" || noFade) envelope = 1;
          else if (u <= fStart) envelope = 1;
          else if (u >= 1) envelope = 0;
          else envelope = Math.pow(1 - (u - fStart) / Math.max(0.0001, 1 - fStart), falloff);

          const cx = x * cellSize;
          const cy = y * cellSize;

          // Halo reveal, computed before any fade culling so the cursor reaches
          // squares the fade has emptied.
          let reveal = 0;
          if (hasCursor) {
            const dx = cx + cellSize * 0.5 - cursorX;
            const dy = cy + cellSize * 0.5 - cursorY;
            const d2 = dx * dx + dy * dy;
            if (d2 < cr2) {
              const k = 1 - d2 / cr2;
              reveal = k * k * cb;
            }
          }

          const osc = 0.5 + 0.5 * Math.sin(t * speed * cell.rate * Math.PI * 2 + cell.phase);
          // The cursor LIFTS the density envelope rather than adding a flat
          // amount, so revealed squares blink like all the rest.
          const finalAlpha = Math.min(1, envelope + reveal) * osc * masterOpacity;
          if (finalAlpha <= 0.002) continue;

          const ci = palette.length > 1 ? Math.min(palette.length - 1, Math.floor(cell.tint * palette.length)) : 0;
          const [r, g, b] = palette[ci];
          ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${finalAlpha.toFixed(3)})`;
          ctx.fillRect(cx + cellSize * inset, cy + cellSize * inset, cellSize * fill, cellSize * fill);
        }
      }
    }

    function loop(now: number) {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
      last = now;
      draw(now, dt);
      raf = requestAnimationFrame(loop);
    }

    function onPointerMove(e: PointerEvent) {
      const rect = box.getBoundingClientRect();
      pointerRef.current.x = e.clientX - rect.left;
      pointerRef.current.y = e.clientY - rect.top;
      pointerRef.current.active = true;
      pointerRef.current.at = performance.now();
    }
    function onPointerLeave() {
      pointerRef.current.active = false;
    }

    resize();
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver((entries) => resize(entries[0]));
    ro.observe(box);

    if (hasCursorInteraction) {
      box.addEventListener("pointermove", onPointerMove);
      box.addEventListener("pointerleave", onPointerLeave);
      box.addEventListener("pointercancel", onPointerLeave);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      box.removeEventListener("pointermove", onPointerMove);
      box.removeEventListener("pointerleave", onPointerLeave);
      box.removeEventListener("pointercancel", onPointerLeave);
    };
  }, [
    gridSize,
    fillPercent,
    colorMode,
    squareColor,
    colorsKey,
    twinkleSpeed,
    opacity,
    fadeDirection,
    fadePercent,
    fadeIntensity,
    hasCursorInteraction,
    cursorRadius,
    cursorBoost,
    autoplay,
  ]);

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
