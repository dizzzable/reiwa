// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetworkCanvas } from "../src/features/landing/landing-background";

/**
 * The link distance and colour the component itself uses. The tests below
 * recompute every expectation from `Math.hypot` — the form the draw loop used
 * before it was switched to a squared-distance compare — so they fail if the
 * cheaper rejection ever selects a different set of pairs than the exact one.
 */
const LINK_DIST = 130;
const COLOR = "#22c55e";
const RGB = "34,197,94";

interface RecordedStroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  style: string;
  lineWidth: number;
}

interface Recording {
  ctx: CanvasRenderingContext2D;
  strokes: RecordedStroke[];
  dots: Array<{ x: number; y: number }>;
  /** How often the loop re-entered the canvas state machine for these. */
  lineWidthWrites: number;
  strokeStyleWrites: number;
}

/**
 * A 2D context that records what was painted. jsdom has no canvas backend, so
 * `getContext('2d')` returns null and the component bails out entirely without
 * this.
 */
function createRecordingContext(): Recording {
  const strokes: RecordedStroke[] = [];
  const dots: Array<{ x: number; y: number }> = [];
  let cursorX = 0;
  let cursorY = 0;
  let segment: { x1: number; y1: number; x2: number; y2: number } | null = null;
  let strokeStyle = "";
  let lineWidth = 0;

  const recording = {
    strokes,
    dots,
    lineWidthWrites: 0,
    strokeStyleWrites: 0,
  } as Recording;

  const ctx = {
    fillStyle: "",
    clearRect: () => undefined,
    setTransform: () => undefined,
    beginPath: () => {
      segment = null;
    },
    moveTo: (x: number, y: number) => {
      cursorX = x;
      cursorY = y;
    },
    lineTo: (x: number, y: number) => {
      segment = { x1: cursorX, y1: cursorY, x2: x, y2: y };
    },
    stroke: () => {
      if (segment !== null) strokes.push({ ...segment, style: strokeStyle, lineWidth });
    },
    arc: (x: number, y: number) => {
      dots.push({ x, y });
    },
    fill: () => undefined,
  };

  Object.defineProperty(ctx, "strokeStyle", {
    get: () => strokeStyle,
    set: (value: string) => {
      strokeStyle = value;
      recording.strokeStyleWrites += 1;
    },
  });
  Object.defineProperty(ctx, "lineWidth", {
    get: () => lineWidth,
    set: (value: number) => {
      lineWidth = value;
      recording.lineWidthWrites += 1;
    },
  });

  recording.ctx = ctx as unknown as CanvasRenderingContext2D;
  return recording;
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

/**
 * Mounts the component against a viewport of exactly `width` x `height`.
 * `animate={false}` makes the component paint a single deterministic frame
 * instead of entering the rAF loop, and skips the drift step inside `draw`.
 */
function paintFrame(width: number, height: number): Recording {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => height,
  });

  const recording = createRecordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    recording.ctx as unknown as RenderingContext,
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() =>
    root.render((<NetworkCanvas color={COLOR} animate={false} />) as ReactElement),
  );
  return recording;
}

/**
 * Pins the seeded node positions. `seed()` draws four randoms per node in the
 * order x, y, vx, vy; the sequence repeats so that a re-seed (a resize) lands
 * on the same layout. Coordinates are divided by a power-of-two viewport, so
 * `Math.random() * width` reproduces them exactly rather than approximately —
 * which is what lets a pair sit *exactly* on the link distance.
 */
function pinNodes(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  height: number,
): void {
  const sequence = points.flatMap(([x, y]) => [x / width, y / height, 0.5, 0.5]);
  let index = 0;
  vi.spyOn(Math, "random").mockImplementation(() => {
    const value = sequence[index % sequence.length];
    index += 1;
    return value;
  });
}

/** Every pair the exact `Math.hypot` form would have drawn, as "i-j" keys. */
function hypotSelectedPairs(points: ReadonlyArray<readonly [number, number]>): string[] {
  const keys: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const distance = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      if (distance < LINK_DIST) keys.push(`${i}-${j}`);
    }
  }
  return keys.sort();
}

/** The pairs actually painted, mapped back onto node indices. */
function paintedPairs(
  strokes: readonly RecordedStroke[],
  points: ReadonlyArray<readonly [number, number]>,
): string[] {
  const indexOf = (x: number, y: number): number =>
    points.findIndex((point) => point[0] === x && point[1] === y);
  return strokes
    .map((stroke) => {
      const a = indexOf(stroke.x1, stroke.y1);
      const b = indexOf(stroke.x2, stroke.y2);
      return a < b ? `${a}-${b}` : `${b}-${a}`;
    })
    .sort();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  // `clientWidth`/`clientHeight` are readonly accessors on the prototype, so
  // they are removed rather than reassigned.
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const VIEWPORT = 512;

/**
 * 18 nodes — the count a 512x512 viewport seeds, where the floor rather than
 * the area term governs — laid out so that 5 pairs sit exactly on the link
 * distance, several sit one pixel either side of it, and the rest are
 * unambiguously near or far.
 */
const BOUNDARY_LAYOUT = [
  [10, 10], // 0
  [140, 10], // 1  — exactly 130 from 0
  [60, 130], // 2  — exactly 130 from 0 (50-120-130)
  [139, 10], // 3  — 129 from 0
  [10, 141], // 4  — 131 from 0
  [10, 139], // 5  — 129 from 0
  [88, 114], // 6  — exactly 130 from 0 (78-104-130)
  [300, 300], // 7
  [380, 300], // 8  — 80 from 7
  [300, 430], // 9  — exactly 130 from 7
  [300, 429], // 10 — 129 from 7
  [450.5, 200.25], // 11 — non-integer, exercises the general float path
  [400, 100], // 12
  [430, 430], // 13 — exactly 130 from 9
  [200, 250], // 14
  [250, 380], // 15
  [480, 60], // 16
  [120, 300], // 17
] as const;

describe("NetworkCanvas link selection", () => {
  it("draws exactly the pairs the Math.hypot form selected", () => {
    pinNodes(BOUNDARY_LAYOUT, VIEWPORT, VIEWPORT);
    const recording = paintFrame(VIEWPORT, VIEWPORT);

    // Guards the fixture itself: if the seeded count ever drifts from the
    // layout, the pinned random sequence would silently desync.
    expect(recording.dots).toHaveLength(BOUNDARY_LAYOUT.length);

    const expected = hypotSelectedPairs(BOUNDARY_LAYOUT);
    expect(expected).toHaveLength(22);
    expect(paintedPairs(recording.strokes, BOUNDARY_LAYOUT)).toEqual(expected);
  });

  it("rejects a pair sitting exactly on the link distance", () => {
    pinNodes(BOUNDARY_LAYOUT, VIEWPORT, VIEWPORT);
    const recording = paintFrame(VIEWPORT, VIEWPORT);
    const painted = new Set(paintedPairs(recording.strokes, BOUNDARY_LAYOUT));

    // `dist < linkDist` is strict, so a pair measuring precisely 130 is not a
    // link. Squaring both sides has to preserve that, or every such pair would
    // pop into existence at the far edge of the mesh.
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [0, 6],
      [7, 9],
      [9, 13],
    ]) {
      const dx = BOUNDARY_LAYOUT[i][0] - BOUNDARY_LAYOUT[j][0];
      const dy = BOUNDARY_LAYOUT[i][1] - BOUNDARY_LAYOUT[j][1];
      expect(Math.hypot(dx, dy)).toBe(LINK_DIST);
      expect(painted.has(`${i}-${j}`)).toBe(false);
    }

    // One pixel inside the boundary is still a link, so the rejection is not
    // simply off by a hair in the safe direction.
    expect(painted.has("0-3")).toBe(true);
    expect(painted.has("0-5")).toBe(true);
    expect(painted.has("7-10")).toBe(true);
  });

  it("fades every drawn link at the alpha the true distance produces", () => {
    pinNodes(BOUNDARY_LAYOUT, VIEWPORT, VIEWPORT);
    const recording = paintFrame(VIEWPORT, VIEWPORT);

    for (const stroke of recording.strokes) {
      const distance = Math.hypot(stroke.x1 - stroke.x2, stroke.y1 - stroke.y2);
      const alpha = ((1 - distance / LINK_DIST) * 0.5).toFixed(3);
      expect(stroke.style).toBe(`rgba(${RGB},${alpha})`);
      expect(stroke.lineWidth).toBe(1);
    }
    expect(recording.strokes.length).toBeGreaterThan(0);
  });

  it("sets the constant line width once per frame rather than once per link", () => {
    pinNodes(BOUNDARY_LAYOUT, VIEWPORT, VIEWPORT);
    const recording = paintFrame(VIEWPORT, VIEWPORT);

    expect(recording.strokes).toHaveLength(22);
    expect(recording.lineWidthWrites).toBe(1);
    // The alpha differs per link, so this one genuinely cannot be hoisted.
    expect(recording.strokeStyleWrites).toBe(recording.strokes.length);
  });
});

/**
 * A 1024x256 strip, which also seeds 18 nodes: a probe pair whose separation
 * the table below dictates, plus 16 fillers as ballast to reach that count.
 * The fillers sit in columns from x=300 rightwards, well clear of the probe
 * pair's own span, so no filler can ever share coordinates with it. Links
 * *between* fillers are harmless noise — the assertion matches the probe
 * pair's exact endpoints, not a stroke count.
 */
const STRIP_W = 1024;
const STRIP_H = 256;
const ANCHOR = [10, 100] as const;
const FILLERS = [
  [300, 40],
  [400, 40],
  [500, 40],
  [600, 40],
  [700, 40],
  [800, 40],
  [900, 40],
  [1000, 40],
  [300, 190],
  [400, 190],
  [500, 190],
  [600, 190],
  [700, 190],
  [800, 190],
  [900, 190],
  [1000, 190],
] as const;

/** dx, dy from the anchor, and whether that pair is a link. */
const BOUNDARY_TABLE: ReadonlyArray<readonly [number, number, boolean]> = [
  // exactly on the boundary — every Pythagorean form of 130
  [130, 0, false],
  [0, 130, false],
  [50, 120, false],
  [120, 50, false],
  [66, 112, false],
  [78, 104, false],
  // one pixel either side
  [129, 0, true],
  [131, 0, false],
  [0, 129, true],
  [0, 131, false],
  [129.5, 0, true],
  // off-axis, either side
  [50, 119, true],
  [50, 121, false],
  [91.5, 91.5, true],
  [92, 92, false],
  // unambiguous
  [0, 0, true],
  [1, 1, true],
  [64, 64, true],
];

describe("NetworkCanvas link distance boundary", () => {
  it.each(BOUNDARY_TABLE)("links a pair offset by (%s, %s): %s", (dx, dy, linked) => {
    // The table is the contract; this keeps it honest against the exact form
    // the loop used to evaluate.
    expect(Math.hypot(dx, dy) < LINK_DIST).toBe(linked);

    const probe = [ANCHOR[0] + dx, ANCHOR[1] + dy] as const;
    const layout = [ANCHOR, probe, ...FILLERS] as ReadonlyArray<readonly [number, number]>;
    pinNodes(layout, STRIP_W, STRIP_H);
    const recording = paintFrame(STRIP_W, STRIP_H);

    expect(recording.dots).toHaveLength(layout.length);
    const drawn = recording.strokes.some(
      (stroke) =>
        (stroke.x1 === ANCHOR[0] &&
          stroke.y1 === ANCHOR[1] &&
          stroke.x2 === probe[0] &&
          stroke.y2 === probe[1]) ||
        (stroke.x1 === probe[0] &&
          stroke.y1 === probe[1] &&
          stroke.x2 === ANCHOR[0] &&
          stroke.y2 === ANCHOR[1]),
    );
    expect(drawn).toBe(linked);
  });
});

describe("NetworkCanvas node density", () => {
  // One `arc` per node, so the dot count is the seeded node count.
  it("caps a large desktop viewport at the ceiling", () => {
    // 1920x950 asks for 91 by area; the ceiling is what answers.
    expect(paintFrame(1920, 950).dots).toHaveLength(70);
  });

  it("lets the area term govern between the two bounds", () => {
    // 1280x700 asks for 45. A 40 ceiling would have clipped it; 70 does not.
    expect(paintFrame(1280, 700).dots).toHaveLength(45);
  });

  it("applies no separate ceiling to a narrow viewport", () => {
    // 600x900 asks for 27 by area and gets 27. A reintroduced `width < 640`
    // ceiling would clip this to 20, which is the density loss that branch
    // actually cost — it never bound on a phone, only on a small tablet.
    expect(paintFrame(600, 900).dots).toHaveLength(27);
  });

  it("holds a phone at the floor, which is what binds there", () => {
    // 390x844 asks for only 16 by area, so neither the ceiling nor the area
    // term governs — the floor does.
    expect(paintFrame(390, 844).dots).toHaveLength(18);
  });
});
