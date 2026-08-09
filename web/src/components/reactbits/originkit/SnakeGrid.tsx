import { useEffect, useRef, type CSSProperties } from "react";

import { resolveBufferRatio } from '../render-scale';

/**
 * Snake Grid — Originkit `snake-grid`, ported to the card-effect shape.
 *
 * Canvas 2D. A self-playing snake breadth-first-searches its way to the food,
 * grows, and when it walls itself in it blinks three times and restarts. No
 * pointer input exists in the original and none was added: the game is its own
 * driver, stepped from an accumulated `dt` so `speed` means cells per second on
 * any refresh rate.
 *
 * Changed from the capture: sizing reads the container rather than the canvas
 * element, per the house rule, and the Framer preset wrapper is gone.
 */

const DEATH_BLINKS = 3;
const BLINK_MS = 180;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RGBA = [number, number, number, number];

function parseColor(color: string): RGBA {
  const value = (color ?? "").trim();
  const hex = value.replace("#", "");
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
  }
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const parts = match[1].split(",").map((p) => parseFloat(p));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] === undefined ? 1 : parts[3]];
  }
  return [255, 255, 255, 1];
}

const rgba = (c: RGBA, alpha: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] * alpha})`;

const STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export interface SnakeGridProps {
  /** Colour of the snake's body. */
  snakeColor?: string;
  /** Colour of the food tile the snake hunts. */
  foodColor?: string;
  /** Background colour of the grid tiles. */
  boardColor?: string;
  /** Target size in pixels for each grid cell. */
  cellSize?: number;
  /** Space in pixels between grid cells. */
  gap?: number;
  /** Corner roundness of each cell, 0 (square) to 20 (circular). */
  rounded?: number;
  /** Cells the snake moves per second. */
  speed?: number;
  /** Segments the snake starts with after each restart. */
  startLength?: number;
  /** Segments added each time it eats. */
  growth?: number;
  /** How much the tail dims toward its end, in percent. */
  fade?: number;
  className?: string;
  style?: CSSProperties;
}

export default function SnakeGrid({
  snakeColor = "#FFFFFF",
  foodColor = "#F9731A",
  boardColor = "rgba(255, 255, 255, 0.06)",
  cellSize = 42,
  gap = 1,
  rounded = 0,
  speed = 10,
  startLength = 1,
  growth = 1,
  fade = 32,
  className = "",
  style,
}: SnakeGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvasEl = canvasRef.current;
    if (!container || !canvasEl) return;
    const context = canvasEl.getContext("2d");
    if (!context) return;
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context;

    const snakeRGB = parseColor(snakeColor);
    const foodRGB = parseColor(foodColor);
    const boardRGB = parseColor(boardColor);

    const rand = mulberry32(0xc0ffee);
    const pitch = cellSize + gap;
    const stepEvery = 1000 / Math.max(1, speed);
    const tailFade = fade / 100;

    let alive = true;
    let raf = 0;
    let last = 0;
    let acc = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let cellW = 0;
    let cellH = 0;
    let pitchX = 0;
    let pitchY = 0;
    let cellRadius = 0;
    let snake: number[] = [];
    let food = -1;
    let dying = 0;
    // One slot per board cell, stamped with the frame that last filled it. Sized
    // once per build and reused, so de-duplicating a frame's fills costs no
    // allocation - see `drawSnake`.
    let drawnStamp = new Int32Array(0);
    let drawnMark = 0;
    // The empty grid is the same picture on every frame, so it is baked once
    // per build and blitted device-pixel for device-pixel. Drawing it inline
    // cost one rounded-rect subpath per cell per frame — a few hundred at the
    // smaller cell sizes, for a layer that never changes.
    let boardLayer: HTMLCanvasElement | null = null;

    const idx = (col: number, row: number) => row * cols + col;
    const colOf = (i: number) => i % cols;
    const rowOf = (i: number) => Math.floor(i / cols);

    function placeFood() {
      const free: number[] = [];
      const body = new Set(snake);
      for (let i = 0; i < cols * rows; i++) {
        if (!body.has(i)) free.push(i);
      }
      food = free.length ? free[Math.floor(rand() * free.length)] : -1;
    }

    /**
     * Lay the starting body out from the middle of the board.
     *
     * The old version walked left along one row and clamped `startLength` to
     * `cols - 2`, which made the usable ceiling a function of `cellSize`: at the
     * default 42 px cells the board is about 7x4, so anything above 5 was
     * silently ignored — and 4 or 5 already ran off the left wall, where
     * `Math.max(0, midCol - i)` piled several segments onto the same cell. A
     * body with duplicate cells is not just a drawing artefact: the pathfinder
     * de-duplicates it through a Set, and `pop()` then removes one copy and
     * leaves a phantom segment behind.
     *
     * The ceiling is now half the board's cells rather than its width, and the
     * body is laid down by walking to free neighbours — preferring left, then
     * up, so a snake short enough to fit in its row comes out exactly where it
     * used to. `startLength` of 1, the default, is unchanged either way.
     */
    function reset() {
      const midCol = Math.floor(cols / 2);
      const midRow = Math.floor(rows / 2);
      const boardCells = cols * rows;
      const ceiling = Math.max(1, Math.floor(boardCells / 2));
      const length = Math.min(Math.max(1, Math.round(startLength)), ceiling);

      const taken = new Uint8Array(boardCells);
      let cell = idx(midCol, midRow);
      snake = [cell];
      taken[cell] = 1;
      // Left, up, right, down: left first reproduces the original row layout.
      const order: ReadonlyArray<readonly [number, number]> = [
        [-1, 0],
        [0, -1],
        [1, 0],
        [0, 1],
      ];
      for (let i = 1; i < length; i++) {
        const col = colOf(cell);
        const row = rowOf(cell);
        let next = -1;
        for (const [dx, dy] of order) {
          const nc = col + dx;
          const nr = row + dy;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const candidate = idx(nc, nr);
          if (taken[candidate]) continue;
          next = candidate;
          break;
        }
        // Boxed in before reaching the requested length; a shorter snake is the
        // only honest answer, and it is still a playable one.
        if (next < 0) break;
        taken[next] = 1;
        snake.push(next);
        cell = next;
      }
      placeFood();
    }

    function blocked(ahead: number): Set<number> {
      const keep = Math.max(0, snake.length - ahead);
      return new Set(snake.slice(0, keep));
    }

    function neighbours(cell: number): number[] {
      const col = colOf(cell);
      const row = rowOf(cell);
      const out: number[] = [];
      for (const [dx, dy] of STEPS) {
        const nc = col + dx;
        const nr = row + dy;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        out.push(idx(nc, nr));
      }
      return out;
    }

    function stepTowardFood(): number {
      if (food < 0) return -1;
      const head = snake[0];
      const walls = blocked(1);
      const prev = new Map<number, number>();
      const seen = new Set<number>([head]);
      let frontier = [head];

      while (frontier.length) {
        const next: number[] = [];
        for (const cell of frontier) {
          for (const n of neighbours(cell)) {
            if (seen.has(n) || walls.has(n)) continue;
            seen.add(n);
            prev.set(n, cell);
            if (n === food) {
              let at = n;
              while (prev.get(at) !== head) {
                at = prev.get(at) as number;
              }
              return at;
            }
            next.push(n);
          }
        }
        frontier = next;
      }
      return -1;
    }

    function room(from: number): number {
      const walls = blocked(1);
      const seen = new Set<number>([from]);
      let frontier = [from];
      let count = 0;
      while (frontier.length && count < cols * rows) {
        const next: number[] = [];
        for (const cell of frontier) {
          count++;
          for (const n of neighbours(cell)) {
            if (seen.has(n) || walls.has(n)) continue;
            seen.add(n);
            next.push(n);
          }
        }
        frontier = next;
      }
      return count;
    }

    function advance() {
      if (!snake.length) return;

      let target = stepTowardFood();
      if (target < 0) {
        const walls = blocked(1);
        let best = -1;
        let bestRoom = -1;
        for (const n of neighbours(snake[0])) {
          if (walls.has(n)) continue;
          const space = room(n);
          if (space > bestRoom) {
            bestRoom = space;
            best = n;
          }
        }
        target = best;
      }

      if (target < 0) {
        dying = DEATH_BLINKS * BLINK_MS * 2;
        return;
      }

      snake.unshift(target);

      if (target === food) {
        // The cap used to be 7 % of the board, which is a smaller number than
        // it looks: the live card runs 32 to 60 cells depending on width, so it
        // resolved to 2, 3 or 4 while the catalog slider went to 6 — the top
        // half of the control did nothing, and which half that was depended on
        // the card's width. A quarter of the board keeps every value on the
        // slider live on every box this effect actually renders in (24 cells in
        // the operator's preview, 32-60 on the card) and still refuses to add
        // six segments at a time to the 4x4 floor `build()` clamps to, where
        // one meal would be more than a third of the board.
        const maxGrowth = Math.max(1, Math.floor((cols * rows) / 4));
        const grow = Math.min(Math.max(1, Math.round(growth)), maxGrowth);
        const tail = snake[snake.length - 1];
        for (let i = 1; i < grow; i++) {
          snake.push(tail);
        }
        placeFood();
      } else {
        snake.pop();
      }
    }

    function tileOn(target: CanvasRenderingContext2D, col: number, row: number) {
      const x = col * pitchX;
      const y = row * pitchY;
      if (cellRadius > 0 && typeof target.roundRect === "function") {
        target.roundRect(x, y, cellW, cellH, cellRadius);
      } else {
        target.rect(x, y, cellW, cellH);
      }
    }

    function tile(col: number, row: number) {
      tileOn(ctx, col, row);
    }

    function build(width: number, height: number) {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      dpr = resolveBufferRatio(w, h, Math.min(window.devicePixelRatio || 1, 2));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.max(4, Math.floor((w + gap) / pitch));
      rows = Math.max(4, Math.floor((h + gap) / pitch));
      cellW = Math.max(1, (w - gap * (cols - 1)) / cols);
      cellH = Math.max(1, (h - gap * (rows - 1)) / rows);
      pitchX = cellW + gap;
      pitchY = cellH + gap;
      cellRadius = (Math.min(cellW, cellH) / 2) * (Math.min(20, Math.max(0, rounded)) / 20);
      if (drawnStamp.length !== cols * rows) drawnStamp = new Int32Array(cols * rows);
      drawnStamp.fill(0);
      drawnMark = 0;

      if (boardLayer) {
        boardLayer.width = 0;
        boardLayer.height = 0;
        boardLayer = null;
      }
      const layer = document.createElement("canvas");
      layer.width = canvas.width;
      layer.height = canvas.height;
      const layerCtx = layer.getContext("2d");
      if (layerCtx) {
        layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        layerCtx.beginPath();
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) tileOn(layerCtx, col, row);
        }
        layerCtx.fillStyle = rgba(boardRGB, 1);
        layerCtx.fill();
        boardLayer = layer;
      }

      reset();
    }

    function drawSnake() {
      // Growth pushes duplicate tail cells. That is standard and the movement
      // code wants it — the duplicates are what `pop()` spends over the next
      // few steps — but drawing is a different question: filling one tile once
      // per duplicate under source-over composites the body colour against
      // itself, so at growth 6 the tail came out nearly opaque against a body
      // the tail fade had deliberately dimmed. Each cell is now filled once,
      // at the first (least faded, nearest the head) index that claims it,
      // which is also the right answer when the head is crossing its own tail.
      // The stamp array is built with the board, so this costs no allocation.
      drawnMark += 1;
      const mark = drawnMark;
      for (let i = 0; i < snake.length; i++) {
        const cell = snake[i];
        if (drawnStamp[cell] === mark) continue;
        drawnStamp[cell] = mark;
        const along = snake.length > 1 ? i / (snake.length - 1) : 0;
        ctx.beginPath();
        tile(colOf(cell), rowOf(cell));
        ctx.fillStyle = rgba(snakeRGB, 1 - along * tailFade);
        ctx.fill();
      }
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

      if (boardLayer) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(boardLayer, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      if (dying > 0) {
        const lit = Math.floor(dying / BLINK_MS) % 2 === 0;
        if (lit) drawSnake();
        return;
      }

      if (food >= 0) {
        ctx.beginPath();
        tile(colOf(food), rowOf(food));
        ctx.fillStyle = rgba(foodRGB, 1);
        ctx.fill();
      }

      drawSnake();
    }

    function loop(time: number) {
      if (!alive) return;
      const dt = last ? Math.min(time - last, 200) : 0;
      last = time;

      if (dying > 0) {
        dying -= dt;
        if (dying <= 0) {
          dying = 0;
          acc = 0;
          reset();
        }
        draw();
        raf = requestAnimationFrame(loop);
        return;
      }

      acc += dt;
      while (acc >= stepEvery && dying <= 0) {
        acc -= stepEvery;
        advance();
      }
      draw();
      raf = requestAnimationFrame(loop);
    }

    const first = container.getBoundingClientRect();
    build(first.width, first.height);

    let built = `${Math.round(first.width)}x${Math.round(first.height)}`;
    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
      if (size === built) return;
      built = size;
      build(rect.width, rect.height);
    });
    ro.observe(container);

    raf = requestAnimationFrame(loop);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (boardLayer) {
        boardLayer.width = 0;
        boardLayer.height = 0;
        boardLayer = null;
      }
    };
  }, [snakeColor, foodColor, boardColor, cellSize, gap, rounded, speed, startLength, growth, fade]);

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
