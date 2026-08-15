/**
 * app-texture — the picture, not just the string.
 *
 * WHAT THIS FILE USED TO GUARD, AND WHY THAT WAS NOTHING
 * -----------------------------------------------------
 * The three original assertions were: the base colour comes through, the
 * `background-image` starts with `url("data:image/svg+xml,`, and the tile size
 * follows the scale. All three hold no matter what is DRAWN inside the SVG. A
 * mutation run proved it — dot radius 2.4 → 9.9, grid stroke 1.2 → 4, tile
 * 40×40 → 40×80, wave control point Q10 18 → Q10 2, noise base frequency
 * 0.9 → 0.1 — five edits that change the background on every subscriber's
 * screen, and the suite stayed green for all five.
 *
 * WHY NOT A SNAPSHOT
 * ------------------
 * A snapshot of the finished string catches all five, and also fails on a
 * reordered attribute, an added space, a different quote — benign edits. A
 * failure with a benign cause is a failure people re-record without reading,
 * and a snapshot that is re-recorded on reflex guards less than no test at all,
 * because it looks like coverage.
 *
 * WHAT IS PINNED INSTEAD
 * ----------------------
 * The GEOMETRY: the numbers that decide what the tile looks like, and nothing
 * about how the markup that carries them is spelled.
 *
 *   • the tile box — 40×40 plus its viewBox. A non-square tile stretches every
 *     pattern, because `background-size` is applied as `Npx Npx`;
 *   • per pattern, the drawing: a circle's centre and radius, or a path's
 *     command stream with its coordinates, plus the stroke width that decides
 *     how heavy the pattern reads;
 *   • for `noise`, the filter parameters — turbulence type, base frequency,
 *     octave count, tile stitching and the alpha row of the colour matrix —
 *     since `noise` has no geometry at all, only a filter;
 *   • how the operator's opacity reaches the pixel: baked into the stroke's
 *     alpha for the seven drawn patterns, carried as `flood-opacity` for noise.
 *
 * A path's `d` is compared as a PARSED command stream with numeric arguments,
 * so `M0 0H40` and `M 0,0 H 40` are the same assertion while `H80` is not. The
 * parser normalises separators, decimal spellings and implicit repeats, but
 * keeps command letters as written: re-authoring a tile in relative
 * coordinates would fail here, which is right — that rewrite has to be
 * re-derived by hand anyway, and this table is the place to record it.
 *
 * The parser is itself under test at the bottom of the file. A comparison that
 * runs both sides through the same helper is only as honest as the helper: a
 * tokeniser that quietly returned `[]` would make every geometry row pass.
 *
 * SCOPE
 * -----
 * This module is mirrored by the panel's
 * `rezeis-admin/web/src/features/branding/app-texture.ts`, which paints the
 * operator's live preview: if the two drift, the preview lies about what the
 * subscriber will see. The panel holds the parity spec that runs both modules
 * against each other (`app-texture.parity.test.ts`, skipped when this checkout
 * is absent). The table below is duplicated verbatim in the panel's
 * `app-texture.test.ts`, so that when the sibling is absent each repo's own
 * suite still fails if only its side of the mirror drifts.
 */
import { describe, expect, it } from "vitest";

import { buildTextureCss, type TextureCss } from "../../web/src/lib/app-texture.js";
import type {
  AppBackgroundTexture,
  AppBackgroundTextureSettings,
} from "../../web/src/types/branding.js";

const PATTERNS: readonly AppBackgroundTexture[] = [
  "dots",
  "grid",
  "diagonal",
  "cross",
  "waves",
  "carbon",
  "triangles",
  "noise",
];

// ── reading the tile back out of the CSS ────────────────────────────────────

const URI_PREFIX = 'url("data:image/svg+xml,';
const URI_SUFFIX = '")';

/** The SVG source the browser would parse, recovered from `background-image`. */
function decodeTile(css: TextureCss): string {
  const image = css.backgroundImage;
  expect(image.startsWith(URI_PREFIX), `not an inline SVG data URI: ${image}`).toBe(true);
  expect(image.endsWith(URI_SUFFIX), `unterminated data URI: ${image}`).toBe(true);
  return decodeURIComponent(image.slice(URI_PREFIX.length, -URI_SUFFIX.length));
}

/**
 * Attributes of the first `<tag …>` in the markup, as a map. Reading them by
 * name rather than by position is the point: reordering attributes changes the
 * string and changes nothing a subscriber can see.
 */
function readElement(svg: string, tag: string): Record<string, string> {
  const element = new RegExp(`<${tag}\\b([^>]*)>`).exec(svg);
  if (element === null) throw new Error(`the tile has no <${tag}>: ${svg}`);
  const attributes: Record<string, string> = {};
  const pair = /([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g;
  let match = pair.exec(element[1]);
  while (match !== null) {
    attributes[match[1]] = match[2];
    match = pair.exec(element[1]);
  }
  return attributes;
}

/** `"0 0 40 40"`, `"0,0,40,40"`, `" 0  0 40 40 "` → `[0, 0, 40, 40]`. */
function numbers(value: string): number[] {
  const tokens = value.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  return tokens.map(Number);
}

// ── path geometry ───────────────────────────────────────────────────────────

interface PathStep {
  readonly command: string;
  readonly args: readonly number[];
}

/** How many numbers each SVG path command consumes per repetition. */
const PATH_ARITY: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  T: 2,
  H: 1,
  V: 1,
  Q: 4,
  S: 4,
  C: 6,
  A: 7,
  Z: 0,
};

/**
 * Tokenise a `d` attribute into commands with numeric arguments.
 *
 * Deliberately tolerant about spelling — separators may be spaces or commas or
 * absent, numbers may be written `.5` or `0.5` or `5e-1` — and deliberately
 * strict about values. Repeated argument groups expand into repeated commands,
 * with SVG's rule that numbers following a moveto are an implicit lineto, so a
 * tile written compactly and the same tile written out compare equal.
 */
function parsePath(d: string): PathStep[] {
  const steps: PathStep[] = [];
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let command = "";
  let args: number[] = [];

  const flush = (): void => {
    if (command === "") return;
    const arity = PATH_ARITY[command.toUpperCase()];
    if (arity === undefined) throw new Error(`unknown path command "${command}" in "${d}"`);
    if (arity === 0) {
      expect(args, `"${command}" takes no arguments in "${d}"`).toEqual([]);
      steps.push({ command, args: [] });
      return;
    }
    expect(
      args.length > 0 && args.length % arity === 0,
      `"${command}" wants a multiple of ${arity} numbers, got ${args.length} in "${d}"`,
    ).toBe(true);
    let repeated = command;
    for (let index = 0; index < args.length; index += arity) {
      steps.push({ command: repeated, args: args.slice(index, index + arity) });
      if (repeated === "M") repeated = "L";
      else if (repeated === "m") repeated = "l";
    }
  };

  for (const token of tokens) {
    if (/[A-Za-z]/.test(token)) {
      flush();
      command = token;
      args = [];
    } else {
      args.push(Number(token));
    }
  }
  flush();
  return steps;
}

/** `["M", 0, 0]` — a command letter followed by its arguments. */
type PathStepSpec = readonly [command: string, ...args: number[]];

function spec(steps: readonly PathStepSpec[]): PathStep[] {
  return steps.map(([command, ...args]) => ({ command, args }));
}

// ── the geometry table ──────────────────────────────────────────────────────
//
// Transcribed from `patternSvg`, and the reason each number is here is that
// changing it changes the picture. Duplicated verbatim in the panel's spec.

interface CircleGeometry {
  readonly kind: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

interface PathGeometry {
  readonly kind: "path";
  readonly strokeWidth: number;
  readonly steps: readonly PathStepSpec[];
}

/** `noise` draws no shape — it floods a full-tile rect through an SVG filter. */
interface FilterGeometry {
  readonly kind: "filter";
}

type Geometry = CircleGeometry | PathGeometry | FilterGeometry;

const GEOMETRY: Readonly<Record<AppBackgroundTexture, Geometry>> = {
  dots: { kind: "circle", cx: 20, cy: 20, r: 2.4 },
  grid: {
    kind: "path",
    strokeWidth: 1.2,
    steps: [
      ["M", 0, 0],
      ["H", 40],
      ["M", 0, 0],
      ["V", 40],
    ],
  },
  diagonal: {
    kind: "path",
    strokeWidth: 1.4,
    steps: [
      ["M", -4, 4],
      ["L", 4, -4],
      ["M", 0, 40],
      ["L", 40, 0],
      ["M", 36, 44],
      ["L", 44, 36],
    ],
  },
  cross: {
    kind: "path",
    strokeWidth: 1.4,
    steps: [
      ["M", 20, 14],
      ["V", 26],
      ["M", 14, 20],
      ["H", 26],
    ],
  },
  waves: {
    kind: "path",
    strokeWidth: 1.4,
    steps: [
      ["M", 0, 30],
      ["Q", 10, 18, 20, 30],
      ["T", 40, 30],
    ],
  },
  carbon: {
    kind: "path",
    strokeWidth: 1.2,
    steps: [
      ["M", 0, 10],
      ["H", 20],
      ["V", 30],
      ["H", 40],
      ["M", 0, 30],
      ["H", 20],
      ["V", 10],
      ["H", 40],
    ],
  },
  triangles: {
    kind: "path",
    strokeWidth: 1.2,
    steps: [
      ["M", 20, 8],
      ["L", 32, 30],
      ["H", 8],
      ["Z"],
    ],
  },
  noise: { kind: "filter" },
};

/** A neutral config: nothing here is clamped, so the output is unfiltered. */
function tile(
  pattern: AppBackgroundTexture,
  overrides: Partial<AppBackgroundTextureSettings> = {},
): TextureCss {
  return buildTextureCss({
    pattern,
    color: "#63f0e0",
    background: "#040b0e",
    scale: 28,
    opacity: 0.17,
    ...overrides,
  });
}

// ── the specs ───────────────────────────────────────────────────────────────

describe("app background textures", () => {
  it.each(PATTERNS)("builds a valid CSS tile for %s", (pattern) => {
    const css = tile(pattern);

    expect(css.backgroundColor).toBe("#040b0e");
    expect(css.backgroundImage).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(css.backgroundSize).toBe("28px 28px");
  });

  it("draws a distinct tile for each of the eight patterns", () => {
    // A renamed or dropped `case` label falls through to the `default` dots
    // tile — the operator picks "waves" and the subscriber gets dots, with
    // every other assertion in this file still satisfied.
    const tiles = PATTERNS.map((pattern) => decodeTile(tile(pattern)));
    expect(new Set(tiles).size).toBe(PATTERNS.length);
  });
});

describe("the tile box", () => {
  it.each(PATTERNS)("is a square 40×40 user-space tile for %s", (pattern) => {
    const svg = readElement(decodeTile(tile(pattern)), "svg");

    // `background-size: Npx Npx` scales the tile to a square. A tile that is
    // not itself square arrives stretched on every subscriber's screen, and
    // the pattern's own coordinates below are all written against 0…40.
    expect(svg.width).toBe("40");
    expect(svg.height).toBe("40");
    expect(numbers(svg.viewBox)).toEqual([0, 0, 40, 40]);
    expect(svg.xmlns).toBe("http://www.w3.org/2000/svg");
  });
});

describe("pattern geometry", () => {
  it.each(PATTERNS)("%s draws the shape it is named for", (pattern) => {
    const svg = decodeTile(tile(pattern));
    const geometry = GEOMETRY[pattern];

    if (geometry.kind === "circle") {
      const circle = readElement(svg, "circle");
      expect(Number(circle.cx)).toBe(geometry.cx);
      expect(Number(circle.cy)).toBe(geometry.cy);
      expect(Number(circle.r)).toBe(geometry.r);
      // Dots are filled, not stroked — a stroke width here would mean the
      // shape changed kind.
      expect(circle.fill).toBeDefined();
      expect(circle["stroke-width"]).toBeUndefined();
      return;
    }

    if (geometry.kind === "path") {
      const path = readElement(svg, "path");
      expect(parsePath(path.d)).toEqual(spec(geometry.steps));
      expect(Number(path["stroke-width"])).toBe(geometry.strokeWidth);
      expect(path.fill).toBe("none");
      return;
    }

    // `noise` is covered by its own describe below; assert only that it did
    // not quietly become a drawn shape.
    expect(svg).toContain("<filter");
    expect(svg).not.toContain("<circle");
    expect(svg).not.toContain("<path");
  });

  it("falls back to the dots tile for a pattern id it does not know", () => {
    // The backend allow-list (`APP_BACKGROUND_TEXTURES` in
    // `public-config-persistence.port.ts`) can grow a pattern before this
    // module does, and the panel's own config types the id as a bare string.
    // Drawing dots is the specified answer; drawing nothing would leave the
    // subscriber with a blank background.
    const circle = readElement(
      decodeTile(tile("spirograph" as AppBackgroundTexture)),
      "circle",
    );
    expect([Number(circle.cx), Number(circle.cy), Number(circle.r)]).toEqual([20, 20, 2.4]);
  });
});

describe("the noise filter", () => {
  const svg = decodeTile(tile("noise"));

  it("is a fractal-noise turbulence at the frequency that makes it grain", () => {
    const turbulence = readElement(svg, "feTurbulence");

    // Base frequency IS the grain size. Drop it an order of magnitude and the
    // tile stops reading as noise and becomes soft blotches; the tile still
    // builds, still encodes, still tiles.
    expect(Number(turbulence.baseFrequency)).toBe(0.9);
    expect(turbulence.type).toBe("fractalNoise");
    expect(Number(turbulence.numOctaves)).toBe(2);
    // Without `stitch` the turbulence does not line up across tile edges and
    // the seams are visible as a grid on the finished background.
    expect(turbulence.stitchTiles).toBe("stitch");
  });

  it("keeps the grain in the alpha channel only", () => {
    const matrix = readElement(svg, "feColorMatrix");
    expect(matrix.type).toBe("matrix");
    // Three zero rows for R/G/B and 0.75 in the alpha slot: the turbulence is
    // used purely as a mask, and 0.75 is how strong that mask is.
    expect(numbers(matrix.values)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.75, 0,
    ]);
    expect(matrix.in).toBe("noise");
  });

  it("tints the mask and composites it over the whole tile", () => {
    const composite = readElement(svg, "feComposite");
    expect([composite.in, composite.in2, composite.operator]).toEqual(["tint", "mask", "in"]);

    const rect = readElement(svg, "rect");
    expect([rect.width, rect.height]).toEqual(["40", "40"]);
    expect(rect.filter).toBe(`url(#${readElement(svg, "filter").id})`);
  });
});

describe("how the operator dials reach the pixel", () => {
  it("bakes the configured opacity into the stroke alpha of a drawn pattern", () => {
    // The seven drawn patterns carry opacity in the colour, not in a separate
    // CSS layer, so this is the only thing standing between the operator's
    // slider and what is painted.
    const path = readElement(decodeTile(tile("grid")), "path");
    expect(path.stroke).toBe("rgba(99,240,224,0.17)");
  });

  it("bakes the configured opacity into the noise texture", () => {
    const css = buildTextureCss({
      pattern: "noise",
      color: "#ffffff",
      background: "#000000",
      scale: 40,
      opacity: 0.23,
    });

    expect(decodeURIComponent(css.backgroundImage)).toContain('flood-opacity="0.23"');
    const flood = readElement(decodeTile(css), "feFlood");
    // Noise keeps the raw hex: its alpha rides on `flood-opacity` instead, so
    // pre-multiplying it into an rgba() would darken the grain twice.
    expect(flood["flood-color"]).toBe("#ffffff");
    expect(Number(flood["flood-opacity"])).toBe(0.23);
  });

  it("clamps opacity to the 0…1 the SVG accepts", () => {
    expect(
      readElement(decodeTile(tile("noise", { opacity: 4 })), "feFlood")["flood-opacity"],
    ).toBe("1");
    expect(
      readElement(decodeTile(tile("noise", { opacity: -1 })), "feFlood")["flood-opacity"],
    ).toBe("0");
    expect(readElement(decodeTile(tile("dots", { opacity: 4 })), "circle").fill).toBe(
      "rgba(99,240,224,1)",
    );
  });

  it("expands shorthand hex and falls back to white on anything unparseable", () => {
    expect(readElement(decodeTile(tile("dots", { color: "#fff" })), "circle").fill).toBe(
      "rgba(255,255,255,0.17)",
    );
    expect(readElement(decodeTile(tile("dots", { color: "chartreuse" })), "circle").fill).toBe(
      "rgba(255,255,255,0.17)",
    );
  });

  it("rounds the scale and clamps it to the 8…256 the form allows", () => {
    expect(tile("dots", { scale: 24.6 }).backgroundSize).toBe("25px 25px");
    expect(tile("dots", { scale: 4 }).backgroundSize).toBe("8px 8px");
    expect(tile("dots", { scale: 4000 }).backgroundSize).toBe("256px 256px");
  });

  it("passes the background colour through untouched", () => {
    expect(tile("dots", { background: "#251225" }).backgroundColor).toBe("#251225");
  });
});

// ── the alpha that reaches the declaration ──────────────────────────────────
//
// Duplicated verbatim in the panel's `app-texture.test.ts`. An out-of-range or
// non-numeric alpha does not produce a WRONG COLOUR — it produces an invalid
// DECLARATION. `rgba(170,29,139,1.7)` makes the browser drop the whole
// `fill`/`stroke`, and the tile inherits whatever was there before, with
// nothing logged and no visual cue pointing at the opacity control. So these
// assert on the produced STRING: a test that parsed the alpha back out with
// `Number()` would read `NaN` and `1.7` as "a number" and pass on both.
//
// This matters more here than in the panel: the panel normalises a draft
// through `branding-form-schema.ts` before it ever reaches this builder, while
// the cabinet hands `branding.appBackground.texture` from the API payload
// straight to `buildTextureCss` with nothing in between.

describe("the alpha baked into the tile", () => {
  const fillFor = (opacity: number, color = "#aa1d8b"): string =>
    readElement(decodeTile(tile("dots", { color, opacity })), "circle").fill;

  it.each([
    ["above 1", 1.7, "rgba(170,29,139,1)"],
    ["below 0", -0.2, "rgba(170,29,139,0)"],
    ["exactly 0", 0, "rgba(170,29,139,0)"],
    ["exactly 1", 1, "rgba(170,29,139,1)"],
    ["NaN", Number.NaN, "rgba(170,29,139,1)"],
    ["a mid value", 0.42, "rgba(170,29,139,0.42)"],
  ])("%s → %s", (_label, opacity, expected) => {
    expect(fillFor(opacity as number)).toBe(expected);
  });

  it('keeps a zero alpha at zero instead of reading it as "not supplied"', () => {
    // `alpha || 1` is the classic spelling of this clamp, and it turns the one
    // setting that means "invisible on purpose" into a fully opaque tile
    // painted over the operator's background. Pinned apart from the table
    // because the table would still pass if this row were quietly dropped.
    expect(fillFor(0)).toBe("rgba(170,29,139,0)");
    expect(fillFor(0)).not.toBe(fillFor(1));
  });

  it("clamps on the unparseable-colour branch as well", () => {
    // This is the branch the clamp was actually missing from: a colour the hex
    // parser rejects fell back to white and interpolated the RAW alpha, so the
    // fallback meant to keep the tile visible emitted a declaration the browser
    // throws away.
    expect(fillFor(1.7, "chartreuse")).toBe("rgba(255,255,255,1)");
    expect(fillFor(-0.2, "chartreuse")).toBe("rgba(255,255,255,0)");
    expect(fillFor(Number.NaN, "chartreuse")).toBe("rgba(255,255,255,1)");
    expect(fillFor(0, "chartreuse")).toBe("rgba(255,255,255,0)");
  });

  it("carries the same clamp to the noise flood-opacity", () => {
    // Noise takes the operator's opacity down a different path — an SVG
    // `flood-opacity` rather than an rgba alpha — and `flood-opacity="NaN"` is
    // rejected just the same. One clamp has to cover both exits.
    const flood = (opacity: number): string =>
      readElement(decodeTile(tile("noise", { opacity })), "feFlood")["flood-opacity"];

    expect(flood(Number.NaN)).toBe("1");
    expect(flood(1.7)).toBe("1");
    expect(flood(-0.2)).toBe("0");
    expect(flood(0)).toBe("0");
    expect(flood(0.42)).toBe("0.42");
  });
});

// ── the helpers themselves ──────────────────────────────────────────────────

describe("the path parser the geometry table leans on", () => {
  // Both sides of every geometry assertion run through `parsePath`. A parser
  // that silently returned `[]`, or dropped the numbers, would make the whole
  // table above pass against any tile at all — which is the failure mode this
  // file exists to end, so it gets its own guard.

  it("reads a compact command stream", () => {
    expect(parsePath("M0 0H40M0 0V40")).toEqual(
      spec([
        ["M", 0, 0],
        ["H", 40],
        ["M", 0, 0],
        ["V", 40],
      ]),
    );
  });

  it("is blind to separators, decimal spelling and whitespace", () => {
    expect(parsePath("M 0,0  H 40   M0,0 V 40")).toEqual(parsePath("M0 0H40M0 0V40"));
    expect(parsePath("M.5 -0.25L4 4")).toEqual(
      spec([
        ["M", 0.5, -0.25],
        ["L", 4, 4],
      ]),
    );
  });

  it("expands an implicit repeat after a moveto into a lineto", () => {
    expect(parsePath("M20 8 32 30")).toEqual(
      spec([
        ["M", 20, 8],
        ["L", 32, 30],
      ]),
    );
  });

  it("sees a changed coordinate", () => {
    expect(parsePath("M0 30Q10 18 20 30T40 30")).not.toEqual(
      parsePath("M0 30Q10 2 20 30T40 30"),
    );
  });

  it("refuses to swallow a command it cannot account for", () => {
    expect(() => parsePath("M0 0K9 9")).toThrow(/unknown path command/);
  });
});
