import { useEffect, useRef, type CSSProperties } from 'react';

import { resolveBufferRatio } from '../render-scale';

// Fallback swatches when the colors list is left empty.
const FALLBACK_COLORS = ['#F9731A', '#FFFFFF'];
// A cleared row flashes white this many times before it collapses away.
const CLEAR_BLINKS = 2;
const BLINK_MS = 90;

// The seven tetromino shapes, each a list of [col, row] cells in its spawn
// rotation. Rotation is computed on the fly, so only the base form lives here.
const SHAPES: Array<Array<[number, number]>> = [
  [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1]
  ], // I
  [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1]
  ], // J
  [
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1]
  ], // L
  [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1]
  ], // S
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1]
  ], // Z
  [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1]
  ], // T
  [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
  ] // O
];

// Seeded PRNG so a board of a given size always plays out the same way.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Colors arrive as hex or rgb/rgba; fold either to [r, g, b, a]. */
function parseColor(color: string): [number, number, number, number] {
  const value = (color ?? '').trim();
  const hex = value.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
  }
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const parts = match[1].split(',').map(p => parseFloat(p));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] === undefined ? 1 : parts[3]];
  }
  return [255, 255, 255, 1];
}

const rgba = (c: [number, number, number, number], alpha: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] * alpha})`;

interface PixelTetrisProps {
  backgroundColor?: string;
  boardColor?: string;
  colors?: string[];
  movement?: number;
  cellSize?: number;
  gap?: number;
  rounded?: number;
  dropSpeed?: number;
  className?: string;
  style?: CSSProperties;
}

interface Piece {
  shape: number; // index into SHAPES
  cells: Array<[number, number]>; // rotated cells, offset by [col, row]
  color: number; // index into the parsed colour list
  col: number;
  row: number;
  // The piece glides from a spawn column/row to the resting cell the AI chose.
  startCol: number;
  startRow: number;
  targetCol: number;
  targetRow: number;
}

/**
 * A self-playing tetris board that fills the card it is given. Pieces spawn at
 * the top, a solver picks the column and rotation that packs the stack
 * tightest, and the piece slides down into place. Whenever a row fills across,
 * it flashes and breaks away, and everything above it drops down. When the
 * stack tops out, the board clears and play starts over.
 */
export default function PixelTetris({
  backgroundColor = 'transparent',
  boardColor = 'rgba(255, 255, 255, 0.06)',
  colors = ['#F9731A', '#FFFFFF'],
  movement = 4,
  cellSize = 29,
  gap = 1,
  rounded = 20,
  dropSpeed = 2,
  className = '',
  style = {}
}: PixelTetrisProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Array identity changes each render; the effect keys on contents instead.
  const colorsRef = useRef<string[]>(colors);
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    colorsRef.current = colors;
  });
  const colorsKey = colors.join(',');

  useEffect(() => {
    const canvasEl = canvasRef.current;
    const containerEl = containerRef.current;
    if (!canvasEl || !containerEl) return;
    const context = canvasEl.getContext('2d');
    if (!context) return;
    const canvas: HTMLCanvasElement = canvasEl;
    const container: HTMLDivElement = containerEl;
    const ctx: CanvasRenderingContext2D = context;

    const boardRGB = parseColor(boardColor);
    // Every block colour, parsed once. Empty list falls back to defaults.
    const palette = colorsRef.current.length ? colorsRef.current : FALLBACK_COLORS;
    const blockRGB = palette.map(parseColor);

    const rand = mulberry32(0x7e7415);
    const pitch = cellSize + gap;
    // How often a settling piece steps down one row, in ms.
    const dropEvery = 1000 / Math.max(1, dropSpeed * 4);
    // 0 -> drop straight into place; 10 -> spawn a full board-width away and
    // glide over. Scales the random horizontal offset the piece starts from.
    const wander = Math.min(10, Math.max(0, movement)) / 10;

    let alive = true;
    let raf = 0;
    let last = 0;
    let dropAcc = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    // Cell size the board actually draws at. Whole cells rarely divide the
    // board exactly at the requested size, so the count is taken first and
    // the cells are then sized to fill what is there.
    let cellW = 0;
    let cellH = 0;
    let pitchX = 0;
    let pitchY = 0;
    let cellRadius = 0;
    let viewW = 1;
    let viewH = 1;
    // Locked cells: colour index into blockRGB if filled, -1 if empty.
    let grid = new Int32Array(0);
    // Scratch of the same shape, used by collapse() so it never allocates.
    let gridSwap = new Int32Array(0);
    let piece: Piece | null = null;
    // Rows currently flashing before they collapse. Empty when nothing clears.
    let clearing: number[] = [];
    let clearMs = 0;

    // Solver scratch, sized with the board. `score()` used to `grid.slice()`
    // and then re-scan the whole board twice for every candidate placement;
    // these hold the parts of that scan that do not change between candidates.
    let rowFill = new Int32Array(0); // filled cells per row
    let colTop = new Int32Array(0); // first filled row per column, or `rows`
    let colHoles = new Int32Array(0); // empty cells below the top, per column
    let topScratch = new Int32Array(0); // colTop with the candidate patched in
    let baseAgg = 0;
    let baseHoles = 0;
    let baseFullRows = 0;
    // Per-candidate scratch: at most four cells, so at most four rows/columns.
    const touchRow = new Int32Array(4);
    const touchRowAdded = new Int32Array(4);
    const touchCol = new Int32Array(4);
    const touchColTop = new Int32Array(4);

    // The resting board never changes between frames, so it is painted once per
    // build into an offscreen canvas and blitted 1:1. Rebuilding it inline cost
    // a rounded-rect subpath per cell - up to 680 of them - every frame.
    let boardLayer: HTMLCanvasElement | null = null;

    const at = (col: number, row: number) => grid[row * cols + col];

    /** Size of the card this background fills, taken from the container. */
    function measure(): [number, number] {
      const rect = container.getBoundingClientRect();
      return [Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height))];
    }

    /** Rotate a base shape 0-3 quarter-turns inside its bounding box. */
    function rotate(shape: number, turns: number): Array<[number, number]> {
      let cells = SHAPES[shape].map(([c, r]) => [c, r] as [number, number]);
      for (let t = 0; t < turns; t++) {
        let maxRow = 0;
        for (const [, r] of cells) maxRow = Math.max(maxRow, r);
        // (c, r) -> (maxRow - r, c) turns the box a quarter clockwise.
        cells = cells.map(([c, r]) => [maxRow - r, c] as [number, number]);
      }
      // Re-seat against the top-left so col/row offsets stay clean.
      let minC = Infinity;
      let minR = Infinity;
      for (const [c, r] of cells) {
        minC = Math.min(minC, c);
        minR = Math.min(minR, r);
      }
      return cells.map(([c, r]) => [c - minC, r - minR] as [number, number]);
    }

    /** Does a set of cells sit on empty, in-bounds squares? */
    function fits(cells: Array<[number, number]>, col: number, row: number) {
      for (const [c, r] of cells) {
        const gc = col + c;
        const gr = row + r;
        if (gc < 0 || gc >= cols || gr >= rows) return false;
        if (gr >= 0 && at(gc, gr) !== -1) return false;
      }
      return true;
    }

    /** Lowest row a shape can rest at from a given column. -1 if it can't. */
    function landing(cells: Array<[number, number]>, col: number): number {
      if (!fits(cells, col, 0)) return -1;
      let row = 0;
      while (fits(cells, col, row + 1)) row++;
      return row;
    }

    /**
     * Measure the board once, before the solver starts trying placements. Every
     * candidate touches at most four cells, so everything the score depends on
     * is either untouched (and read from here) or recomputed for the handful of
     * rows and columns that changed.
     */
    function surveyBoard() {
      rowFill.fill(0);
      baseFullRows = 0;
      for (let r = 0; r < rows; r++) {
        let filled = 0;
        for (let c = 0; c < cols; c++) {
          if (grid[r * cols + c] !== -1) filled++;
        }
        rowFill[r] = filled;
        if (filled === cols) baseFullRows++;
      }

      baseAgg = 0;
      baseHoles = 0;
      for (let c = 0; c < cols; c++) {
        let top = rows;
        for (let r = 0; r < rows; r++) {
          if (grid[r * cols + c] !== -1) {
            top = r;
            break;
          }
        }
        colTop[c] = top;
        baseAgg += rows - top;
        let holes = 0;
        for (let r = top + 1; r < rows; r++) {
          if (grid[r * cols + c] === -1) holes++;
        }
        colHoles[c] = holes;
        baseHoles += holes;
        topScratch[c] = top;
      }
    }

    /**
     * Score a resting placement - higher is a tighter, flatter pack. Returns
     * exactly what the full-board version returned; it just gets there by
     * writing the four cells into `grid`, measuring the difference, and putting
     * them back, instead of copying and re-scanning the whole board.
     */
    function score(cells: Array<[number, number]>, col: number, row: number) {
      let placed = 0;
      let touchedRows = 0;
      let touchedCols = 0;

      for (const [c, r] of cells) {
        const gr = row + r;
        if (gr < 0) continue;
        const gc = col + c;
        grid[gr * cols + gc] = 1;
        placed++;

        let slot = -1;
        for (let k = 0; k < touchedRows; k++) {
          if (touchRow[k] === gr) {
            slot = k;
            break;
          }
        }
        if (slot < 0) {
          touchRow[touchedRows] = gr;
          touchRowAdded[touchedRows] = 1;
          touchedRows++;
        } else {
          touchRowAdded[slot]++;
        }

        slot = -1;
        for (let k = 0; k < touchedCols; k++) {
          if (touchCol[k] === gc) {
            slot = k;
            break;
          }
        }
        if (slot < 0) {
          touchCol[touchedCols] = gc;
          touchColTop[touchedCols] = gr;
          touchedCols++;
        } else if (gr < touchColTop[slot]) {
          touchColTop[slot] = gr;
        }
      }

      // A row the piece did not touch is exactly as full as it was. A row it
      // did touch had at least one empty cell (the piece landed there), so it
      // cannot have been full already.
      let lines = baseFullRows;
      for (let k = 0; k < touchedRows; k++) {
        if (rowFill[touchRow[k]] + touchRowAdded[k] === cols) lines++;
      }

      let aggHeight = baseAgg;
      let holes = baseHoles;
      for (let k = 0; k < touchedCols; k++) {
        const c = touchCol[k];
        const top = touchColTop[k] < colTop[c] ? touchColTop[k] : colTop[c];
        aggHeight += colTop[c] - top;
        let colHoleCount = 0;
        for (let r = top + 1; r < rows; r++) {
          if (grid[r * cols + c] === -1) colHoleCount++;
        }
        holes += colHoleCount - colHoles[c];
        topScratch[c] = top;
      }

      let bump = 0;
      for (let c = 1; c < cols; c++) bump += Math.abs(topScratch[c] - topScratch[c - 1]);

      for (let k = 0; k < touchedCols; k++) topScratch[touchCol[k]] = colTop[touchCol[k]];
      if (placed > 0) {
        for (const [c, r] of cells) {
          const gr = row + r;
          if (gr >= 0) grid[gr * cols + (col + c)] = -1;
        }
      }

      // Weights are the well-worn Dellacherie-style set: reward clears,
      // punish height, holes, and a jagged surface.
      return lines * 4.0 - aggHeight * 0.5 - holes * 3.5 - bump * 0.3;
    }

    /** Pick the best column + rotation for the next shape and spawn it. */
    function spawn() {
      const shape = Math.floor(rand() * SHAPES.length);
      let bestCells: Array<[number, number]> | null = null;
      let bestCol = 0;
      let bestRow = 0;
      let bestScore = -Infinity;

      surveyBoard();
      for (let turn = 0; turn < 4; turn++) {
        const cells = rotate(shape, turn);
        let width = 0;
        for (const [c] of cells) width = Math.max(width, c);
        for (let col = 0; col + width < cols; col++) {
          const row = landing(cells, col);
          if (row < 0) continue;
          const s = score(cells, col, row);
          if (s > bestScore) {
            bestScore = s;
            bestCells = cells;
            bestCol = col;
            bestRow = row;
          }
        }
      }

      // Nowhere to land - the stack has reached the ceiling. Wipe and restart.
      if (!bestCells) {
        grid.fill(-1);
        piece = null;
        return;
      }

      // Spawn fully above the board so the fall reads as motion. Wander
      // pushes the spawn column sideways off the target, and the piece
      // glides back to it on the way down - bigger Movement, farther swing.
      let startRow = 0;
      let width = 0;
      for (const [c, r] of bestCells) {
        startRow = Math.max(startRow, r);
        width = Math.max(width, c);
      }
      startRow = -1 - startRow;
      // Keep the whole piece inside the walls: the spawn column can range
      // from 0 to cols-1-width, so no cell ever starts or glides off-board.
      const maxCol = cols - 1 - width;
      const swing = Math.round((rand() * 2 - 1) * wander * cols);
      const startCol = Math.min(maxCol, Math.max(0, bestCol + swing));
      const color = blockRGB.length > 1 ? Math.floor(rand() * blockRGB.length) : 0;
      piece = {
        shape,
        cells: bestCells,
        color,
        col: startCol,
        row: startRow,
        startCol,
        startRow,
        targetCol: bestCol,
        targetRow: bestRow
      };
    }

    function lock() {
      if (!piece) return;
      for (const [c, r] of piece.cells) {
        const gr = piece.row + r;
        const gc = piece.col + c;
        if (gr >= 0 && gr < rows && gc >= 0 && gc < cols) {
          grid[gr * cols + gc] = piece.color;
        }
      }
      piece = null;

      // Collect any rows that filled all the way across.
      const full: number[] = [];
      for (let r = 0; r < rows; r++) {
        let solid = true;
        for (let c = 0; c < cols; c++) {
          if (grid[r * cols + c] === -1) {
            solid = false;
            break;
          }
        }
        if (solid) full.push(r);
      }
      if (full.length) {
        clearing = full;
        clearMs = CLEAR_BLINKS * BLINK_MS * 2;
      }
    }

    /** Is this row one of the handful currently flashing? */
    function isClearing(row: number) {
      for (let i = 0; i < clearing.length; i++) {
        if (clearing[i] === row) return true;
      }
      return false;
    }

    /** Remove the flashing rows and drop everything above them down. */
    function collapse() {
      const next = gridSwap;
      next.fill(-1);
      let write = rows - 1;
      for (let r = rows - 1; r >= 0; r--) {
        if (isClearing(r)) continue;
        for (let c = 0; c < cols; c++) {
          next[write * cols + c] = grid[r * cols + c];
        }
        write--;
      }
      gridSwap = grid;
      grid = next;
      clearing = [];
    }

    function build() {
      const [w, h] = measure();
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      dpr = resolveBufferRatio(w, h, Math.min(window.devicePixelRatio || 1, 2));
      viewW = w;
      viewH = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // How many WHOLE cells fit at the requested size: n cells span
      // n * cellSize + (n - 1) * gap, so n = (w + gap) / pitch, rounded down.
      cols = Math.max(4, Math.floor((w + gap) / pitch));
      rows = Math.max(6, Math.floor((h + gap) / pitch));
      // Then size the cells to that count, so the grid runs from the
      // top-left corner to the far edge exactly.
      cellW = Math.max(1, (w - gap * (cols - 1)) / cols);
      cellH = Math.max(1, (h - gap * (rows - 1)) / rows);
      pitchX = cellW + gap;
      pitchY = cellH + gap;
      // Rounded is 0-20, mapped rather than raw pixels: 20 means half the
      // cell, a full circle, whatever the cell size happens to be.
      cellRadius = (Math.min(cellW, cellH) / 2) * (Math.min(20, Math.max(0, rounded)) / 20);
      grid = new Int32Array(cols * rows).fill(-1);
      gridSwap = new Int32Array(cols * rows);
      rowFill = new Int32Array(rows);
      colTop = new Int32Array(cols);
      colHoles = new Int32Array(cols);
      topScratch = new Int32Array(cols);
      piece = null;
      clearing = [];
      clearMs = 0;

      // Bake the resting board. Same context state, same size, so the blit in
      // draw() is a straight device-pixel copy of what the inline version drew.
      if (boardLayer) {
        boardLayer.width = 0;
        boardLayer.height = 0;
      }
      const layer = document.createElement('canvas');
      layer.width = canvas.width;
      layer.height = canvas.height;
      const layerCtx = layer.getContext('2d');
      if (layerCtx) {
        layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        layerCtx.beginPath();
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) tilePathOn(layerCtx, c, r);
        }
        layerCtx.fillStyle = rgba(boardRGB, 1);
        layerCtx.fill();
        boardLayer = layer;
      } else {
        boardLayer = null;
      }

      spawn();
    }

    function tilePathOn(target: CanvasRenderingContext2D, col: number, row: number) {
      const x = col * pitchX;
      const y = row * pitchY;
      if (cellRadius > 0 && typeof target.roundRect === 'function') {
        target.roundRect(x, y, cellW, cellH, cellRadius);
      } else {
        target.rect(x, y, cellW, cellH);
      }
    }

    function tilePath(col: number, row: number) {
      tilePathOn(ctx, col, row);
    }

    /** The parsed colour for a colour index, clamped to the list. */
    function colorFor(index: number): [number, number, number, number] {
      return blockRGB[index] ?? blockRGB[0];
    }

    function draw() {
      ctx.clearRect(0, 0, viewW, viewH);

      // Resting board: every empty square at its base colour. Gaps stay
      // clear so the component sits over whatever is behind it.
      if (boardLayer) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(boardLayer, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const lit = clearMs > 0 && Math.floor(clearMs / BLINK_MS) % 2 === 0;

      // Locked stack, one path per colour. Tiles never overlap - a cell is a
      // cell - so filling them together is the same picture as filling them one
      // at a time, minus up to 680 `beginPath`/`fill` pairs a frame.
      for (let k = 0; k < blockRGB.length; k++) {
        let any = false;
        ctx.beginPath();
        for (let r = 0; r < rows; r++) {
          const rowLit = lit && isClearing(r);
          if (rowLit) continue;
          for (let c = 0; c < cols; c++) {
            const color = grid[r * cols + c];
            if (color === -1) continue;
            if ((blockRGB[color] ? color : 0) !== k) continue;
            tilePath(c, r);
            any = true;
          }
        }
        if (!any) continue;
        ctx.fillStyle = rgba(blockRGB[k], 1);
        ctx.fill();
      }

      // Flashing rows strobe white on the lit half-beat.
      if (lit) {
        let any = false;
        ctx.beginPath();
        for (let i = 0; i < clearing.length; i++) {
          const r = clearing[i];
          for (let c = 0; c < cols; c++) {
            if (grid[r * cols + c] === -1) continue;
            tilePath(c, r);
            any = true;
          }
        }
        if (any) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.fill();
        }
      }

      // The falling piece, full strength.
      if (piece) {
        ctx.fillStyle = rgba(colorFor(piece.color), 1);
        ctx.beginPath();
        for (const [c, r] of piece.cells) {
          const gr = piece.row + r;
          if (gr < 0) continue;
          tilePath(piece.col + c, gr);
        }
        ctx.fill();
      }
    }

    function loop(time: number) {
      if (!alive) return;
      const dt = last ? Math.min(time - last, 200) : 0;
      last = time;

      if (clearMs > 0) {
        // Hold the board while the full rows strobe, then collapse them.
        clearMs -= dt;
        if (clearMs <= 0) {
          clearMs = 0;
          collapse();
          spawn();
        }
        draw();
        raf = requestAnimationFrame(loop);
        return;
      }

      if (piece) {
        dropAcc += dt;
        while (dropAcc >= dropEvery && piece) {
          dropAcc -= dropEvery;
          if (piece.row < piece.targetRow) {
            piece.row++;
            // Glide the column toward the target in step with the
            // fall, so the piece lands exactly where the solver chose.
            const span = piece.targetRow - piece.startRow;
            const prog = span > 0 ? (piece.row - piece.startRow) / span : 1;
            piece.col = Math.round(piece.startCol + (piece.targetCol - piece.startCol) * prog);
          } else {
            piece.col = piece.targetCol;
            lock();
          }
        }
      } else {
        // Nothing falling - start the next piece straight away.
        spawn();
      }

      draw();
      raf = requestAnimationFrame(loop);
    }

    build();

    // A new size is a new grid, so the board is rebuilt and play starts
    // over. Also covers the first layout, which can land after this effect
    // with the container still measuring nothing.
    let built = `${viewW}x${viewH}`;
    const ro = new ResizeObserver(() => {
      const [w, h] = measure();
      const size = `${w}x${h}`;
      if (size === built) return;
      built = size;
      build();
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
  }, [boardColor, colorsKey, movement, cellSize, gap, rounded, dropSpeed]);

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
