// @vitest-environment jsdom

/**
 * Waves draws on the MAIN THREAD, so its bitmap is capped — and capping a
 * bitmap must not move a single line.
 *
 * WHAT THIS REPLACES. A previous round sized this canvas from `offsetWidth`
 * instead of `getBoundingClientRect()` and pushed the pointer through the ratio
 * between the two, so that a `transform: scale()` above the component would
 * shrink the bitmap. That transform is gone: it changed the picture (a 10 px
 * lattice became 33 px), it was invisible to the twenty effects that measure
 * with gBCR, and it clipped `prismGrid`. The cap now lives here, on the BITMAP
 * only, with the CSS box left exactly as CSS made it.
 *
 * WHY THE LATTICE PITCH IS THE ASSERTION. `canvas.width` alone would pass for
 * both designs — the old one also shrank the bitmap. What tells them apart is
 * what happens to the drawing: under the old design every point moved, under
 * this one none of them do. The path is read back out of the 2d context, so
 * `xGap` is measured where it is actually drawn rather than where it is
 * configured.
 *
 * NOT ASSERTED, because jsdom cannot: that a real 2d context resamples through
 * `setTransform`. jsdom has no rasteriser. The transform CALL is asserted; what
 * the GPU does with it is the platform's contract.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Waves from "../src/components/reactbits/Waves";

/** The container's box. jsdom gives every element 0×0, so it is scripted. */
const box = { width: 0, height: 0, left: 0, top: 0 };

interface DrawnPath {
  readonly moves: Array<{ x: number; y: number }>;
  readonly lines: Array<{ x: number; y: number }>;
  readonly transforms: number[][];
}

let frames: FrameRequestCallback[] = [];
let resizeObserved: Array<() => void> = [];
let drawn: DrawnPath;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

class CapturingResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    resizeObserved.push(this.callback);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
  // Frames are driven by hand. `tick` re-arms itself every frame, so a real
  // rAF would leave the loop running across tests and the smoothed pointer
  // would drift away from the value being asserted.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // The component seeds its Perlin field with `Math.random()` per mount, so two
  // mounts draw two different pictures. Every case below that compares one
  // mount against another needs them to differ ONLY in what is being tested.
  vi.spyOn(Math, "random").mockReturnValue(0.42);
  drawn = { moves: [], lines: [], transforms: [] };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "2d"
        ? {
            clearRect: () => undefined,
            beginPath: () => undefined,
            moveTo: (x: number, y: number) => drawn.moves.push({ x, y }),
            lineTo: (x: number, y: number) => drawn.lines.push({ x, y }),
            setTransform: (...args: number[]) => drawn.transforms.push(args),
            stroke: () => undefined,
            strokeStyle: "",
          }
        : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: box.width,
        height: box.height,
        left: box.left,
        top: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  frames = [];
  resizeObserved = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Mounted {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
}

function mountWaves(props: Record<string, unknown> = {}): Mounted {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Waves {...props} />));
  const container = host.firstElementChild as HTMLElement;
  return { container, canvas: container.querySelector("canvas")! };
}

/**
 * Unmount and reset the recorders.
 *
 * `cancelAnimationFrame` is stubbed to a no-op, so a frame the component queued
 * before unmounting stays in `frames` and would run again against the NEXT
 * mount — which silently doubled every captured path the first time this file
 * ran two components in one case.
 */
function unmountWaves(): void {
  if (root !== null) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  frames = [];
  resizeObserved = [];
  drawn = { moves: [], lines: [], transforms: [] };
}

/** Run every frame currently queued, exactly once. */
function runFrame(): void {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(0);
  });
}

function movePointer(clientX: number, clientY: number): void {
  act(() => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY }));
  });
  runFrame();
}

/** Where the component believes the pointer is, in container CSS pixels. */
function pointerInCssSpace(container: HTMLElement): { x: number; y: number } {
  return {
    x: Number.parseFloat(container.style.getPropertyValue("--x")),
    y: Number.parseFloat(container.style.getPropertyValue("--y")),
  };
}

/**
 * Every distinct x the lattice was drawn at, in the order they appear.
 *
 * Read with `waveAmpX`/`waveAmpY` at zero so the drawn path IS the lattice: the
 * wave displacement is a per-point offset that would otherwise scatter each
 * column by up to ±32 px and make "the pitch" unmeasurable from the output.
 * What is being asserted is the SPACING the component put between columns, and
 * that is only visible with the decoration switched off.
 */
function drawnColumns(): number[] {
  return [
    ...new Set([...drawn.moves, ...drawn.lines].map(point => Math.round(point.x * 100) / 100)),
  ].sort((a, b) => a - b);
}

function drawnColumnPitch(): number[] {
  const xs = drawnColumns();
  return [...new Set(xs.slice(1).map((x, index) => Math.round((x - xs[index]) * 100) / 100))];
}

describe("Waves on a card — nothing may change at all", () => {
  beforeEach(() => {
    Object.assign(box, { width: 343, height: 201, left: 12.25, top: 4.75 });
  });

  it("keeps the exact bitmap it had, integer truncation included", () => {
    const { canvas } = mountWaves();

    expect(canvas.width).toBe(343);
    expect(canvas.height).toBe(201);
    // Ratio 1: the identity transform, i.e. the context this component has
    // always drawn into.
    expect(drawn.transforms.at(-1)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("truncates a fractional box exactly as the canvas attribute did", () => {
    Object.assign(box, { width: 342.5, height: 200.5 });
    const { canvas } = mountWaves();

    expect(canvas.width).toBe(342);
    expect(canvas.height).toBe(200);
  });

  it("puts the pointer at container CSS coordinates", () => {
    const { container } = mountWaves();

    movePointer(box.left + 100, box.top + 60);

    expect(pointerInCssSpace(container)).toEqual({ x: 100, y: 60 });
  });
});

describe("Waves full-screen — the bitmap comes down, the picture does not", () => {
  // 2560×1440 CSS: 3.7M bitmap pixels to clear and stroke per frame on the
  // thread that handles input. The budget resolves to 0.75.
  beforeEach(() => {
    Object.assign(box, { width: 2560, height: 1440, left: 0, top: 0 });
  });

  it("caps the bitmap at the device-pixel budget", () => {
    const { canvas } = mountWaves();

    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(1920 * 1080);
  });

  it("scales the context by the same factor, so CSS units still land right", () => {
    mountWaves();

    expect(drawn.transforms.at(-1)).toEqual([0.75, 0, 0, 0.75, 0, 0]);
  });

  it("draws the lattice at the SAME pitch it draws on a card", () => {
    // The whole point. `xGap` defaults to 10 CSS px; the deleted transform
    // design would have put these columns 13.33 apart here and 10 apart on a
    // card — the same effect rendering two different pictures, which is what
    // the codebase's "identical in the cabinet and in the preview" rule
    // forbids.
    // Wave amplitude AND cursor travel switched off: both are per-point offsets
    // on top of the lattice, and either one scatters the columns by enough to
    // make "the pitch" unreadable from the drawn output. The initial pointer
    // sits at x = -10, which is inside the cursor's 175 px radius, so the
    // corner columns move even with no pointer event at all.
    const flat = { waveAmpX: 0, waveAmpY: 0, maxCursorMove: 0 };
    /** What `setLines` produces for a box of `cssWidth`, at the default xGap. */
    const expectedColumns = (cssWidth: number) => Math.ceil((cssWidth + 200) / 10) + 1;

    mountWaves(flat);
    runFrame();
    expect(drawnColumnPitch()).toEqual([10]);
    // The COUNT, from the CSS box and not the bitmap. Pitch alone does not
    // separate the two designs — shrinking the box keeps the pitch and drops
    // the count, which is exactly what the deleted governor did. Asserted as
    // the arithmetic so the number cannot be back-fitted.
    expect(drawnColumns().length).toBe(expectedColumns(2560));
    unmountWaves();

    Object.assign(box, { width: 343, height: 201 });
    mountWaves(flat);
    runFrame();
    expect(drawnColumnPitch()).toEqual([10]);
    expect(drawnColumns().length).toBe(expectedColumns(343));
  });

  it("puts the pointer at container CSS coordinates here too", () => {
    const { container } = mountWaves();

    movePointer(1280, 720);

    // Not 960/540 — that would be bitmap space, which is what the deleted
    // design put here and what made the cursor dot sit off the pointer.
    expect(pointerInCssSpace(container)).toEqual({ x: 1280, y: 720 });
  });
});

describe("Waves re-measurement", () => {
  beforeEach(() => {
    Object.assign(box, { width: 400, height: 300, left: 0, top: 0 });
  });

  it("follows the container box without a window resize", () => {
    // A card is a grid cell: it moves when a sibling appears or a font loads,
    // and the window hears about none of that.
    const { canvas } = mountWaves();
    expect(canvas.width).toBe(400);

    Object.assign(box, { width: 200, height: 150 });
    act(() => {
      for (const notify of resizeObserved) notify();
    });

    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(150);
  });

  it("does not rebuild the lattice for a box that did not move", () => {
    // `setLines` discards every point's accumulated cursor displacement, so a
    // rebuild is visible as the trail snapping back. Both mounts below run the
    // identical number of frames; the only difference is a resize event for a
    // box that never moved. Same input, same picture, or the guard is gone.
    const withoutResize = runPerturbedPath(false);
    const withResize = runPerturbedPath(true);

    expect(withResize).toEqual(withoutResize);
    // …and the paths really are perturbed, or the comparison above would hold
    // for a component that ignored the pointer entirely.
    expect(withResize).not.toEqual(runPristinePath());
  });
});

/**
 * Mount, disturb the lattice with the pointer, optionally fire a resize for an
 * unchanged box, and return the path drawn on the next frame.
 */
function runPerturbedPath(withResize: boolean): Array<{ x: number; y: number }> {
  unmountWaves();
  Object.assign(box, { width: 400, height: 300, left: 0, top: 0 });
  mountWaves();
  // TWO moves, not one. The first `updateMouse` sets `mouse.lx = mouse.x`
  // itself, so a single move leaves the velocity at zero — and the cursor
  // force is multiplied by that velocity, so every point stays exactly on the
  // lattice and a rebuild would be invisible. Found by running the mutation:
  // with one move, deleting the guard under test changed nothing at all.
  movePointer(120, 90);
  movePointer(200, 150);
  for (let i = 0; i < 4; i++) runFrame();
  if (withResize) {
    act(() => {
      window.dispatchEvent(new Event("resize"));
      for (const notify of resizeObserved) notify();
    });
  }
  drawn = { moves: [], lines: [], transforms: [] };
  runFrame();
  const path = drawn.lines;
  unmountWaves();
  return path;
}

/** The same frame count with no pointer near the lattice at all. */
function runPristinePath(): Array<{ x: number; y: number }> {
  unmountWaves();
  Object.assign(box, { width: 400, height: 300, left: 0, top: 0 });
  mountWaves();
  for (let i = 0; i < 5; i++) runFrame();
  drawn = { moves: [], lines: [], transforms: [] };
  runFrame();
  const path = drawn.lines;
  unmountWaves();
  return path;
}
