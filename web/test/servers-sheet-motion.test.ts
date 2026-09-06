import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  rowDelay,
  SERVERS_SHEET_MOTION,
  totalDuration,
} from "../src/features/servers/servers-sheet-motion";

/**
 * How the servers screen arrives, and the promises that make it "smooth".
 *
 * The ask was a planet that appears gently on a double tap, with the list
 * coming in behind it. That is an ORDER and a BUDGET, and neither survives on
 * its own: a delay nudged here and a duration nudged there and the list is
 * suddenly racing the planet, or the whole screen takes two seconds to settle
 * and the gesture feels broken. Both are one-line edits and neither shows up in
 * a screenshot.
 *
 * jsdom cannot watch an animation, so nothing here times anything. What it can
 * hold is the arithmetic behind the sequence and the shape of the source that
 * plays it — which is where every one of those one-line edits would land.
 */

const sheetSource = readFileSync(
  new URL("../src/features/servers/servers-sheet.tsx", import.meta.url),
  "utf8",
);
const motionCss = readFileSync(
  new URL("../src/features/servers/servers-sheet-motion.css", import.meta.url),
  "utf8",
);

/** The contents of every `attribute={...}` in the source, braces balanced. */
function attributeValues(source: string, attribute: string): string[] {
  const values: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`${attribute}={`, from);
    if (at === -1) return values;
    let depth = 0;
    let index = at + attribute.length + 1;
    const start = index;
    do {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    } while (depth > 0 && index < source.length);
    values.push(source.slice(start + 1, index - 1));
    from = index;
  }
}

describe("the servers screen arrives in order", () => {
  it("leads with the planet and brings the list in behind it", () => {
    // The ask, in three numbers. Everything else in this file exists to stop
    // these three drifting past one another.
    expect(SERVERS_SHEET_MOTION.planet.delay).toBeLessThan(
      SERVERS_SHEET_MOTION.recommended.delay,
    );
    expect(SERVERS_SHEET_MOTION.recommended.delay).toBeLessThan(
      SERVERS_SHEET_MOTION.list.delay,
    );
    // And the first row must not start before the planet does, which is what
    // "the list behind it" means at its weakest.
    expect(rowDelay(0)).toBeGreaterThan(SERVERS_SHEET_MOTION.planet.delay);
  });

  it("gives the planet the longest arrival of anything on the screen", () => {
    // It is the answer to the gesture. A planet that snaps in faster than its
    // own list reads as an error, not a reveal.
    const others = [
      SERVERS_SHEET_MOTION.backdrop.duration,
      SERVERS_SHEET_MOTION.header.duration,
      SERVERS_SHEET_MOTION.recommended.duration,
      SERVERS_SHEET_MOTION.list.duration,
    ];
    for (const duration of others) {
      expect(SERVERS_SHEET_MOTION.planet.duration).toBeGreaterThan(duration);
    }
  });

  it("settles within a second, whatever the operator has configured", () => {
    // Fourteen servers is a real install; forty is a large one. Neither may
    // turn a double tap into something the customer waits out.
    expect(totalDuration(14)).toBeLessThanOrEqual(1);
    expect(totalDuration(40)).toBeLessThanOrEqual(1);
  });

  it("stops the stagger compounding once the effect has been made", () => {
    const cap = SERVERS_SHEET_MOTION.maxStaggeredRows;
    expect(rowDelay(cap)).toBeGreaterThan(rowDelay(cap - 1));
    // Past the cap every remaining row arrives together, so row 40 is not a
    // second and a half behind row 1.
    expect(rowDelay(cap + 1)).toBe(rowDelay(cap));
    expect(rowDelay(400)).toBe(rowDelay(cap));
  });

  it("grows the planet in rather than sliding it", () => {
    expect(SERVERS_SHEET_MOTION.planet.scaleFrom).toBeLessThan(1);
    expect(SERVERS_SHEET_MOTION.planet.scaleFrom).toBeGreaterThan(0.75);
  });
});

describe("what the screen is allowed to animate", () => {
  it("moves nothing but opacity and transform", () => {
    // A `filter`, a `width` or a `backdrop-filter` in any of these would
    // re-rasterise a full-screen blurred surface on every frame — on a phone
    // that is the difference between a reveal and a stutter. The backdrop's
    // blur is set once, in a plain `style`, and never animated.
    const allowed = new Set(["opacity", "scale", "x", "y"]);
    const values = [
      ...attributeValues(sheetSource, "initial"),
      ...attributeValues(sheetSource, "animate"),
      ...attributeValues(sheetSource, "exit"),
    ];
    const animated = new Set<string>();
    for (const value of values) {
      // Only what is inside an object literal. The values also hold ternary
      // heads (`reducedMotion ? false : {…}`), and a naive scan reads the `:`
      // of the ternary as a property — which is what the first version of this
      // test did, and it reported `false` and `undefined` as animated.
      for (const literal of value.matchAll(/\{([^{}]*)\}/g)) {
        for (const match of (literal[1] as string).matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:/g)) {
          animated.add(match[1] as string);
        }
      }
    }
    const forbidden = [...animated].filter((name) => !allowed.has(name));
    expect(
      forbidden,
      `these are animated but only opacity and transform may be: ${forbidden.join(", ")}`,
    ).toEqual([]);
    // And the set is not empty, or this test would pass on a screen that
    // animates nothing at all.
    expect(animated.has("opacity")).toBe(true);
  });

  it("asks every entrance what it does under reduced motion", () => {
    // The whole sequence is decoration over a screen that works standing still.
    // Anything with an `initial` has to say so on the spot; a single one that
    // forgets moves a reader who asked not to be moved.
    const compact = sheetSource.replace(/\s+/g, " ");
    const parts = compact.split("initial={").slice(1);
    expect(parts.length, "no entrances found — did the file move?").toBeGreaterThan(3);
    for (const raw of parts) {
      const part = raw.trimStart();
      expect(
        part.startsWith("reducedMotion") || part.startsWith("!reducedMotion"),
        `an entrance ignores reduced motion: initial={${part.slice(0, 40)}…`,
      ).toBe(true);
    }
  });
});

describe("the planet's own reveal", () => {
  it("fades the canvas, and crosses nothing but its opacity", () => {
    // The globe flips an inline `opacity` from 0 to 1 the moment its scene is
    // built, which React cannot reach and which lands at whatever moment the
    // lazy chunk finished. A transition is the only place to catch it.
    //
    // The property list is read rather than searched: `transition: opacity …,
    // filter …` also CONTAINS "transition: opacity", and a filter crossed on
    // the most expensive surface of this screen is the stutter this whole file
    // exists to prevent.
    const rule = motionCss.match(/\.servers-planet canvas \{([^}]*)\}/);
    expect(rule, "no reveal rule for the planet's canvas").not.toBeNull();
    const declaration = (rule as RegExpMatchArray)[1].match(/transition:([^;]*);/);
    expect(declaration, "the reveal rule transitions nothing").not.toBeNull();
    const properties = (declaration as RegExpMatchArray)[1]
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0]);
    expect(properties).toEqual(["opacity"]);
  });

  it("keeps the stylesheet and the timing table in step", () => {
    const match = motionCss.match(/transition: opacity (\d+)ms/);
    expect(match, "no canvas reveal duration in the stylesheet").not.toBeNull();
    expect(Number((match as RegExpMatchArray)[1])).toBe(
      SERVERS_SHEET_MOTION.canvasRevealMs,
    );
  });

  it("turns the reveal off for reduced motion, below the rule that sets it", () => {
    // Equal specificity, so source order decides — the same rule the cabinet's
    // shared stylesheet lives by.
    const rule = motionCss.indexOf(".servers-planet canvas {");
    const guard = motionCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(rule).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(rule);
    expect(motionCss.slice(guard)).toMatch(/transition: none/);
  });

  it("hangs that reveal on a class the screen actually sets", () => {
    // On the `className`, not merely somewhere in the file: the comment beside
    // the planet's box names the class too, and a check for the bare word
    // passes with the class deleted from the markup.
    expect(sheetSource).toMatch(/className="servers-planet/);
    expect(sheetSource).toContain("./servers-sheet-motion.css");
  });
});
