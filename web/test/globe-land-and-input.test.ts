import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { geoEquirectangular, geoPath } from "d3-geo";
import { describe, expect, it } from "vitest";

import { LAND_110M } from "../src/components/reactbits/originkit/globe-land-110m";
import { countryPoint } from "../src/features/servers/country-points";

/**
 * The two things the globe port must not lose.
 *
 * WHY THIS EXISTS. `Globe` is vendored from Originkit, and the vendoring
 * changed exactly two things that a future re-port would silently undo, because
 * both look like the upstream file being "restored to how it ships".
 *
 * ONE — THE LAND MUST NOT COME OFF THE NETWORK. Upstream's mount effect did:
 *
 *     await fetch("https://raw.githubusercontent.com/.../ne_50m_land.json")
 *
 * 2.76 MB from a third party's server, fetched again on every mount, on a
 * screen a customer reaches by double-tapping their subscription card — and
 * producing nothing at all if they were offline or GitHub was blocked, which
 * for a good share of the people this product exists for is the normal case.
 * The data now ships in `globe-land-110m`. Re-pasting the upstream file would
 * restore the request and nothing else would complain: the component still
 * renders, on a developer's machine, on a fast connection.
 *
 * TWO — A FINGER MUST BE ABLE TO TURN IT. Upstream bound `mousedown` on the
 * canvas and `mousemove`/`mouseup` on `document`. That is mouse-only. This
 * cabinet is a Telegram mini app, so the interaction the whole screen is built
 * around — spin the globe, look at where your servers are — did not exist on
 * the devices that matter. A re-port would take the drag away again while every
 * test that renders the component still passed, because jsdom has no fingers.
 *
 * The land assertions are not decoration either: the shipped data is generated,
 * stripped of its properties and rounded, and `d3-geo` is what has to accept
 * the result. Land that no longer paths is land that renders as an empty ball.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGINKIT = resolve(HERE, "..", "src", "components", "reactbits", "originkit");

const read = (file: string) => readFileSync(join(ORIGINKIT, file), "utf8");

/** Every possible alpha-2 code, so a table sweep cannot miss an entry. */
const ALPHA2: readonly string[] = (() => {
  const codes: string[] = [];
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      codes.push(String.fromCharCode(a, b));
    }
  }
  return codes;
})();

/** Every globe variant the operator can choose between. */
const VARIANTS = ["Globe.tsx", "GlobeMesh.tsx", "DitherGlobe.tsx"] as const;

describe("baked Natural Earth land", () => {
  it("is a non-empty FeatureCollection of polygons", () => {
    expect(LAND_110M.type).toBe("FeatureCollection");
    expect(LAND_110M.features.length).toBeGreaterThan(100);
    for (const feature of LAND_110M.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(feature.geometry.type);
    }
  });

  it("keeps every coordinate on the Earth", () => {
    // A stray value here does not throw; it projects to somewhere off the
    // raster and quietly removes a continent from the dot mask.
    let checked = 0;
    const walk = (node: unknown): void => {
      if (!Array.isArray(node)) return;
      if (typeof node[0] === "number" && typeof node[1] === "number") {
        const [lng, lat] = node as [number, number];
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
        checked += 1;
        return;
      }
      for (const child of node) walk(child);
    };
    walk(LAND_110M.features.map((f) => f.geometry.coordinates));
    expect(checked).toBeGreaterThan(4000);
  });

  it("still paths through d3-geo the way the component draws it", () => {
    // The exact pipeline `Globe` runs to build its 2048x1024 land mask. If the
    // generated file drifts into a shape d3-geo walks past, the globe renders
    // as a bare sphere and no type or lint check notices.
    let moves = 0;
    let lines = 0;
    const context = {
      beginPath: () => {},
      moveTo: () => {
        moves += 1;
      },
      lineTo: () => {
        lines += 1;
      },
      arc: () => {},
      closePath: () => {},
    };

    const projection = geoEquirectangular().fitSize([2048, 1024], {
      type: "Sphere",
    } as never);
    const path = geoPath().projection(projection).context(context as never);

    for (const feature of LAND_110M.features) path(feature as never);

    // One subpath per ring at minimum, and the coastline detail behind them.
    expect(moves).toBeGreaterThanOrEqual(LAND_110M.features.length);
    expect(lines).toBeGreaterThan(4000);
  });
});

describe("the country marker table", () => {
  /**
   * WHY REFERENCE COORDINATES AND NOT JUST A RANGE CHECK.
   *
   * The table is generated from Natural Earth by resolving each feature to a
   * two-letter code. The first generator also accepted `POSTAL` and `WB_A2` as
   * fallbacks — and those are not ISO codes. Northern Cyprus has POSTAL `CN`
   * and Somaliland has POSTAL `SL`, so both silently OVERWROTE real countries:
   * China's marker was drawn in the eastern Mediterranean, 6300 km from China,
   * and Sierra Leone's in the Horn of Africa. Every value was still a valid
   * coordinate, every entry was still unique, and the count was still right —
   * a range check sees none of it. Only comparing against where these places
   * actually are does.
   */
  const REFERENCE: Readonly<Record<string, readonly [number, number]>> = {
    DE: [51, 10],
    FR: [46, 2],
    NL: [52, 5],
    NO: [62, 10],
    GB: [54, -2],
    TR: [39, 35],
    RU: [61, 96],
    US: [39, -99],
    BR: [-10, -53],
    CN: [35, 104],
    JP: [36, 138],
    IN: [22, 79],
    AU: [-25, 134],
    ZA: [-29, 24],
    SL: [8, -11],
    SO: [5, 46],
    SG: [1, 104],
  };

  it("puts every well-known country where it belongs", () => {
    for (const [code, [lat, lng]] of Object.entries(REFERENCE)) {
      const point = countryPoint(code);
      expect(point, `${code} is missing from the table`).not.toBeNull();
      const [gotLat, gotLng] = point as readonly [number, number];
      // Generous: these are landmass centroids, not capitals.
      expect(Math.abs(gotLat - lat), `${code} latitude`).toBeLessThan(7);
      expect(Math.abs(gotLng - lng), `${code} longitude`).toBeLessThan(9);
    }
  });

  it("holds a plausible number of countries", () => {
    // Anchors the two cases around it: a table that stopped being generated
    // would answer `null` everywhere and pass a shape check.
    let found = 0;
    for (const code of ALPHA2) if (countryPoint(code) !== null) found += 1;
    expect(found).toBeGreaterThan(150);
  });

  it("keeps every coordinate on Earth", () => {
    for (const code of ALPHA2) {
      const point = countryPoint(code);
      if (point === null) continue;
      expect(point[0], `${code} latitude`).toBeGreaterThanOrEqual(-90);
      expect(point[0], `${code} latitude`).toBeLessThanOrEqual(90);
      expect(point[1], `${code} longitude`).toBeGreaterThanOrEqual(-180);
      expect(point[1], `${code} longitude`).toBeLessThanOrEqual(180);
    }
  });

  it("gives no two countries the same point", () => {
    // A collision is what a silent overwrite leaves behind when the loser was
    // never written at all — and a duplicate is what it leaves when both were.
    const seen = new Map<string, string>();
    for (const code of ALPHA2) {
      const point = countryPoint(code);
      if (point === null) continue;
      const key = `${point[0]},${point[1]}`;
      expect(seen.has(key), `${code} shares a point with ${seen.get(key)}`).toBe(false);
      seen.set(key, code);
    }
  });

  it("has no point for a code that is not a country", () => {
    // `EU` is the ordinary case: a load balancer flagged with the European
    // flag decodes to a valid indicator pair that names no single place. It
    // must stay absent so the caller lists the server without drawing it.
    expect(countryPoint("EU")).toBeNull();
    expect(countryPoint("XX")).toBeNull();
    expect(countryPoint("constructor")).toBeNull();
    expect(countryPoint(null)).toBeNull();
  });
});

describe("the ported globes", () => {
  it.each(VARIANTS)("%s asks the network for nothing", (file) => {
    const source = read(file);
    // `raw.githubusercontent` survives in Globe's docblock, which is the point
    // of the docblock; a call is what must not come back.
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bXMLHttpRequest\b/);
    expect(source).not.toMatch(/https:\/\/[^\s"']+\.json/);
  });

  it.each(VARIANTS)("%s takes its drag from pointer events, not the mouse", (file) => {
    const source = read(file);
    expect(source).toMatch(/addEventListener\(\s*["']pointerdown["']/);
    // The upstream mouse pair is what made this touch-blind. Its absence is
    // the assertion — `MouseEvent` in a handler signature means it is back.
    expect(source).not.toMatch(/addEventListener\(\s*["']mousedown["']/);
    expect(source).not.toMatch(/\bMouseEvent\b/);
  });

  it.each(VARIANTS)("%s keeps the browser from stealing the gesture", (file) => {
    // Without `touch-action: none` the browser treats the drag as a scroll and
    // pans the sheet instead, which looks exactly like the globe ignoring the
    // finger.
    expect(read(file)).toMatch(/touchAction\s*=\s*["']none["']/);
  });

  it("Globe releases every listener it binds", () => {
    const source = read("Globe.tsx");
    const bound = [...source.matchAll(/canvas\.addEventListener\(\s*["'](\w+)["']/g)].map(
      (m) => m[1],
    );
    const released = new Set(
      [...source.matchAll(/canvas\.removeEventListener\(\s*["'](\w+)["']/g)].map((m) => m[1]),
    );
    expect(bound.length).toBeGreaterThan(0);
    for (const event of bound) expect(released).toContain(event);
  });
});
