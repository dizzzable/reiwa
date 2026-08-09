import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { motion } from "motion/react";

/**
 * Prism Grid — Originkit `prism-grid`, ported to the card-effect shape.
 *
 * DOM, not canvas: a CSS-perspective grid of bordered cells with one lit cell
 * and a short queue of fading ones on top, animated by motion.
 *
 * WHY IT LOOKED BROKEN, and the fix
 * ---------------------------------
 * Unlike its two siblings this one had no animation loop of any kind — no rAF,
 * no interval, no clock. Every visible pixel came from `useState` written only
 * by `handlePointerMove`. The one `setTimeout` in the file is fade cleanup and
 * cannot fire until a pointer has already lit a cell, so with no pointer the
 * component rendered an empty grid forever.
 *
 * So this port adds the scheduler it lacked, and makes that loop the single
 * path that lights cells: it walks a point around the grid, derives a cell, and
 * calls `setLit` only when the cell actually changes — a couple of times a
 * second, not once a frame. The pointer handler no longer sets state at all; it
 * just records where the pointer is, and the same loop reads it. `blend` decides
 * which of the two positions is in force, so a real pointer takes over within a
 * few frames and, on release, the lit cell walks off toward the synthetic path
 * instead of vanishing. The loop parks itself when `autoplay` is false and
 * nothing is happening, and wakes on the next pointer event.
 *
 * Also fixed on the way through:
 *
 * - Fade cleanup leaked. One shared `setTimeout` keyed on the whole `fading`
 *   array was cleared and restarted every time a cell was added, so under
 *   continuous movement — exactly what an autopilot produces — it never fired
 *   and the array grew without bound. Each fading cell now owns its timer.
 * - Grid measurement used `window` resize and `clientWidth`; it is now a
 *   `ResizeObserver` on the container, per the house rule.
 * - The initial `rows`/`cols` state was 35/35, building 1225 elements at mount
 *   before the layout effect corrected it. Starts at 1/1 now.
 * - The `colors` prop also accepts a plain string array, which is how the card
 *   palettes are already expressed.
 * - Dropped the unused `zoomProbeRef` element and the `framer-motion` import
 *   path in favour of `motion/react`.
 */

const DEFAULT_COLORS = ["#FFFFFF", "#FFC2E3", "#DEFFEA", "#A68F1F", "#A85E5E", "#DFC2FF"];

const DEFAULT_COLORS_PROP: ColorsProp = {
  paletteCount: 6,
  color1: "#FFFFFF",
  color2: "#FFC2E3",
  color3: "#DEFFEA",
  color4: "#A68F1F",
  color5: "#A85E5E",
  color6: "#DFC2FF",
  color7: "rgb(147 197 253)",
  color8: "rgb(165 180 252)",
  color9: "rgb(196 181 253)",
  color10: "rgb(125 211 252)",
};

const DEFAULT_ROTATE: Rotate = { x: 0, y: 0 };

const PERSPECTIVE = 1000;
const IN_DURATION = 0;
const OUT_DURATION = 1;

const AUTOPILOT_DWELL_MS = 600;
const AUTOPILOT_IN_TAU = 0.9;
const AUTOPILOT_OUT_TAU = 0.12;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The synthetic cursor, in grid fractions. Three sine terms per axis, all six
 * periods incommensurable, tuned by simulating a 9x6 grid over two minutes: it
 * changes cell about 2.4 times a second, reaches 53 of the 54 cells, and never
 * sits in one cell longer than 1.5 s — long dwells matter because the trail
 * behind the lit cell fades in one second, so a stationary head goes bare. The
 * amplitudes sum to just under a half, keeping the point inside the grid; a
 * walk that strayed outside would park the trail against an edge.
 */
function autoFracX(t: number) {
  return 0.5 + 0.36 * Math.sin(t * 0.67) + 0.09 * Math.sin(t * 1.79 + 1.3) + 0.045 * Math.sin(t * 3.07 + 0.4);
}
function autoFracY(t: number) {
  return 0.5 + 0.36 * Math.sin(t * 0.476 + 2.1) + 0.09 * Math.sin(t * 1.235 + 0.6) + 0.045 * Math.sin(t * 2.364 + 2.2);
}

function screenToPlane(
  sx: number,
  sy: number,
  yawDeg: number,
  pitchDeg: number,
  p = PERSPECTIVE
): { x: number; y: number } | null {
  const a = (yawDeg * Math.PI) / 180;
  const b = (pitchDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);

  const a11 = p * ca - sx * sa * cb;
  const a12 = sx * sb;
  const a21 = p * sa * sb - sy * sa * cb;
  const a22 = p * cb + sy * sb;

  const det = a11 * a22 - a12 * a21;
  if (!isFinite(det) || Math.abs(det) < 1e-6) return null;

  const b1 = sx * p;
  const b2 = sy * p;
  return {
    x: (b1 * a22 - a12 * b2) / det,
    y: (a11 * b2 - b1 * a21) / det,
  };
}

interface Cell {
  id: number;
  row: number;
  col: number;
  color: string;
}

export interface Rotate {
  x?: number;
  y?: number;
}

export interface ColorsProp {
  paletteCount?: number;
  [key: string]: string | number | undefined;
}

export interface PrismGridProps {
  /** Fill colour behind the grid. */
  backgroundColor?: string;
  /** Size of each square cell, in pixels. */
  boxSize?: number;
  /** Thickness of the lines separating cells, in pixels. */
  borderWidth?: number;
  /** Colour of the grid lines. */
  borderColor?: string;
  /** Tilts the grid in 3D: `x` swings it left/right, `y` front/back. */
  rotate?: Rotate;
  /** Palette a lit cell draws its colour from; array or the keyed object form. */
  colors?: ColorsProp | readonly string[];
  /** Walk a synthetic cursor over the grid when no real one is present. */
  autoplay?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface Live {
  cols: number;
  rows: number;
  boxSize: number;
  swingX: number;
  swingY: number;
  autoplay: boolean;
  colors: string[];
}

export default function PrismGrid({
  backgroundColor = "rgba(0,0,0,1)",
  boxSize = 40,
  borderWidth = 2,
  borderColor = "rgba(255,255,255,0.2)",
  rotate = DEFAULT_ROTATE,
  colors: colorsProp = DEFAULT_COLORS_PROP,
  autoplay = true,
  className = "",
  style,
}: PrismGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  const [rows, setRows] = useState(1);
  const [lit, setLit] = useState<Cell | null>(null);
  const [fading, setFading] = useState<Cell[]>([]);

  const idRef = useRef(0);
  const litRef = useRef<Cell | null>(null);
  const pointerRef = useRef({ active: false, fx: 0.5, fy: 0.5, leftAt: 0 });
  const wakeRef = useRef<(() => void) | null>(null);
  const timersRef = useRef(new Set<number>());

  const swingX = rotate?.x ?? 0;
  const swingY = rotate?.y ?? 0;

  const colors = useMemo(() => {
    const entries: string[] = [];
    if (Array.isArray(colorsProp)) {
      for (const value of colorsProp) {
        if (typeof value === "string" && value.trim().length > 0) entries.push(value.trim());
      }
    } else if (colorsProp) {
      const palette = colorsProp as ColorsProp;
      const count = Math.max(1, Math.min(10, palette.paletteCount || 6));
      for (let i = 1; i <= count; i++) {
        const value = palette[`color${i}`];
        if (typeof value === "string" && value.trim().length > 0) entries.push(value.trim());
      }
    }
    return entries.length === 0 ? DEFAULT_COLORS : entries;
  }, [colorsProp]);

  const liveRef = useRef<Live>({ cols, rows, boxSize, swingX, swingY, autoplay, colors });
  useEffect(() => {
    liveRef.current = { cols, rows, boxSize, swingX, swingY, autoplay, colors };
    wakeRef.current?.();
  }, [cols, rows, boxSize, swingX, swingY, autoplay, colors]);

  // Grid geometry from the container, not the window.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const w = rect.width || el.offsetWidth || 1;
      const h = rect.height || el.offsetHeight || 1;
      setCols(Math.max(1, Math.ceil(w / boxSize)));
      setRows(Math.max(1, Math.ceil(h / boxSize)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxSize]);

  // The scheduler the original never had.
  useEffect(() => {
    let raf = 0;
    let startTime = 0;
    let lastTime = 0;
    let blend = 1;

    const randomColor = () => {
      const palette = liveRef.current.colors;
      if (palette.length === 0) return DEFAULT_COLORS[0];
      return palette[Math.floor(Math.random() * palette.length)];
    };

    /** Each fading cell owns its own timer, so a steady stream cannot pile up. */
    const pushFading = (cell: Cell) => {
      setFading((f) => [...f, cell]);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer);
        setFading((f) => f.filter((c) => c.id !== cell.id));
      }, OUT_DURATION * 1000);
      timersRef.current.add(timer);
    };

    const lightCell = (row: number, col: number) => {
      const prev = litRef.current;
      if (prev && prev.row === row && prev.col === col) return;
      const next: Cell = { id: ++idRef.current, row, col, color: randomColor() };
      litRef.current = next;
      if (prev) pushFading(prev);
      setLit(next);
    };

    const clearLit = () => {
      const prev = litRef.current;
      if (!prev) return;
      litRef.current = null;
      pushFading(prev);
      setLit(null);
    };

    const loop = (time: number) => {
      const live = liveRef.current;
      const ptr = pointerRef.current;
      if (!startTime) startTime = time;
      const dtSec = lastTime ? Math.min(time - lastTime, 100) / 1000 : 1 / 60;
      lastTime = time;
      const t = (time - startTime) / 1000;

      const dwelling = !ptr.active && ptr.leftAt > 0 && time - ptr.leftAt < AUTOPILOT_DWELL_MS;
      const wantsAuto = live.autoplay && !ptr.active && !dwelling;
      const goal = wantsAuto ? 1 : 0;
      const tau = wantsAuto ? AUTOPILOT_IN_TAU : AUTOPILOT_OUT_TAU;
      blend += (goal - blend) * (1 - Math.exp(-dtSec / tau));

      let fx = 0;
      let fy = 0;
      let has = false;
      if (live.autoplay) {
        has = true;
        fx = lerp(ptr.fx, autoFracX(t), blend);
        fy = lerp(ptr.fy, autoFracY(t), blend);
      } else if (ptr.active) {
        has = true;
        fx = ptr.fx;
        fy = ptr.fy;
      }

      if (has) {
        const col = Math.floor(fx * live.cols);
        const row = Math.floor(fy * live.rows);
        if (col < 0 || col >= live.cols || row < 0 || row >= live.rows) clearLit();
        else lightCell(row, col);
      } else {
        clearLit();
      }

      // Nothing to animate and no autopilot: park until a pointer wakes us.
      if (!live.autoplay && !ptr.active && blend < 0.002 && !litRef.current) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    const wake = () => {
      if (raf) return;
      lastTime = 0;
      raf = requestAnimationFrame(loop);
    };
    wakeRef.current = wake;
    wake();

    const timers = timersRef.current;
    return () => {
      wakeRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const live = liveRef.current;
    const rect = container.getBoundingClientRect();
    const sx = event.clientX - rect.left - rect.width / 2;
    const sy = event.clientY - rect.top - rect.height / 2;

    const ptr = pointerRef.current;
    const point = screenToPlane(sx, sy, live.swingX, live.swingY);
    const gridWidth = live.cols * live.boxSize;
    const gridHeight = live.rows * live.boxSize;
    // A point the projection cannot resolve, or one off the grid, counts as the
    // pointer having left — the autopilot then eases back in as usual.
    if (!point || !gridWidth || !gridHeight) {
      if (ptr.active) {
        ptr.active = false;
        ptr.leftAt = performance.now();
      }
      wakeRef.current?.();
      return;
    }

    const fx = (point.x + gridWidth / 2) / gridWidth;
    const fy = (point.y + gridHeight / 2) / gridHeight;
    if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) {
      if (ptr.active) {
        ptr.active = false;
        ptr.leftAt = performance.now();
      }
      wakeRef.current?.();
      return;
    }

    ptr.fx = fx;
    ptr.fy = fy;
    ptr.active = true;
    ptr.leftAt = 0;
    wakeRef.current?.();
  }, []);

  const handlePointerLeave = useCallback(() => {
    const ptr = pointerRef.current;
    if (!ptr.active) return;
    ptr.active = false;
    ptr.leftAt = performance.now();
    wakeRef.current?.();
  }, []);

  const gridWidth = cols * boxSize;
  const gridHeight = rows * boxSize;
  const border = borderWidth ? `${borderWidth}px solid ${borderColor}` : undefined;

  const boxes = useMemo(() => {
    const rowsArray = new Array<number>(rows).fill(1);
    const colsArray = new Array<number>(cols).fill(1);
    return rowsArray.map((_, i) => (
      <div
        key={`row-${i}`}
        style={{
          display: "flex",
          borderLeft: border,
          borderBottom: i === rows - 1 ? border : undefined,
        }}
      >
        {colsArray.map((__, j) => (
          <div
            key={`col-${j}`}
            style={{
              width: `${boxSize}px`,
              height: `${boxSize}px`,
              flexShrink: 0,
              boxSizing: "border-box",
              borderRight: border,
              borderTop: border,
            }}
          />
        ))}
      </div>
    ));
  }, [rows, cols, boxSize, border]);

  // The row elements carry a left border outside their content box, so their
  // cells start that far in. Without this the lit overlay sat a border-width
  // left of the cell it was supposed to be filling.
  const rowInset = border ? borderWidth : 0;

  const cellStyle = (cell: Cell): CSSProperties => ({
    position: "absolute",
    left: cell.col * boxSize + rowInset,
    top: cell.row * boxSize,
    width: boxSize,
    height: boxSize,
    backgroundColor: cell.color,
    pointerEvents: "none",
  });

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      style={{ backgroundColor, ...style }}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          perspective: `${PERSPECTIVE}px`,
          perspectiveOrigin: "center center",
          transformStyle: "preserve-3d",
        }}
      >
        <div
          style={{
            transform: `translate(-50%, -50%) rotateY(${swingX}deg) rotateX(${swingY}deg)`,
            position: "absolute",
            left: "50%",
            top: "50%",
            display: "flex",
            flexDirection: "column",
            transformOrigin: "center center",
            width: `${gridWidth}px`,
            height: `${gridHeight}px`,
            zIndex: 0,
          }}
        >
          {boxes}
          {fading.map((cell) => (
            <motion.div
              key={cell.id}
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{ duration: OUT_DURATION }}
              style={cellStyle(cell)}
            />
          ))}
          {lit && (
            <motion.div
              key={lit.id}
              initial={{ opacity: IN_DURATION > 0 ? 0 : 1 }}
              animate={{ opacity: 1 }}
              transition={{ duration: IN_DURATION }}
              style={cellStyle(lit)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
