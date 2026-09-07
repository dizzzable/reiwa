import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What the operator's colour actually does, effect by effect.
 *
 * THE REPORT: "сам эффект работает, а на цвет не реагирует." It was true, and
 * of one effect in particular. The panel shows a colour swatch beside all five,
 * and iridescence ignored it outright — a fixed rainbow drawn with
 * `mix-blend-mode: color`, which then painted over the tinted glyph as well. An
 * operator could set that icon to pink and find nothing anywhere on it pink.
 *
 * So this file states the promise the swatch makes, per effect, and holds it:
 *
 *   • glow, glint, iridescent — the colour is IN the effect;
 *   • pulse, shake — pure motion, so the colour reaches only the glyph, which
 *     `icon-decor.ts` tints regardless of which effect is chosen.
 *
 * A sixth effect added tomorrow has to appear below, in one list or the other.
 * That is the point of the census at the end: a new effect that quietly ignores
 * the swatch is the exact defect this file was written for.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("../../web/src/index.css", import.meta.url)),
  "utf8",
);

const BEGIN = "/* icon-effects:begin";
const END = "/* icon-effects:end */";

const block = (() => {
  const from = CSS.indexOf(BEGIN);
  const to = CSS.indexOf(END);
  expect(from, "the icon-effects markers are gone from index.css").toBeGreaterThan(-1);
  return CSS.slice(CSS.indexOf("\n", from) + 1, to).replace(/\r\n/g, "\n");
})();

/** Everything the stylesheet says about one effect: its rules and pseudo-elements. */
function rulesFor(effect: string): string {
  const lines = block.split("\n");
  const collected: string[] = [];
  let depth = 0;
  let capturing = false;
  for (const line of lines) {
    if (!capturing && depth === 0 && line.includes(`.icon-effect-${effect}`) && !line.startsWith("@")) {
      capturing = true;
    }
    if (capturing) collected.push(line);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (capturing && depth === 0) capturing = false;
  }
  return collected.join("\n");
}

const COLOUR_LED = ["glow", "glint", "iridescent"] as const;
const MOTION_ONLY = ["pulse", "shake"] as const;

describe("the colour an operator picks", () => {
  for (const effect of COLOUR_LED) {
    it(`is drawn INTO the ${effect}`, () => {
      const rules = rulesFor(effect);
      expect(rules.length, `no rules found for .icon-effect-${effect}`).toBeGreaterThan(20);
      expect(
        rules.includes("--icon-effect-color") || rules.includes("--icon-sheen"),
        `.icon-effect-${effect} never reads the operator's colour — the swatch beside it in the panel promises something it cannot deliver`,
      ).toBe(true);
    });
  }

  for (const effect of MOTION_ONLY) {
    it(`leaves the ${effect} to pure motion, where a colour has no meaning`, () => {
      // Not an oversight, and not a gap to be filled: a scale and a wobble have
      // no surface to colour. The glyph underneath is tinted by `icon-decor.ts`
      // whichever effect is chosen, so the swatch is never inert.
      const rules = rulesFor(effect);
      expect(rules).toContain("animation:");
      expect(rules).not.toContain("--icon-effect-color");
    });
  }

  it("leads the iridescent sheen with that colour rather than a fixed rainbow", () => {
    // The reported case, named. Both layers, because a sheen tinted on one and
    // fixed on the other reads as a rainbow that flickers toward the colour.
    const rules = rulesFor("iridescent");
    const tinted = block.slice(block.indexOf("@supports (color: color-mix"));
    expect(rules).toContain("--icon-sheen: var(--icon-effect-color");
    expect(tinted).toContain(".icon-effect-iridescent::before");
    expect(tinted).toContain(".icon-effect-iridescent::after");
    expect((tinted.match(/var\(--icon-sheen\)/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("keeps the shipped rainbow for a browser without color-mix", () => {
    // `@supports`, not a second declaration: a declaration containing `var()`
    // is valid at PARSE time, so an unsupported `color-mix` fails later, at
    // computed-value time, and resolves to `unset` — NOT to the plain gradient
    // above it. iOS below 16.2 has no `color-mix`, and on those devices the
    // icon has to keep looking like something rather than nothing.
    expect(block).toContain("@supports (color: color-mix(in oklab, red 50%, blue))");
    const beforeSupports = block.slice(0, block.indexOf("@supports (color: color-mix"));
    expect(beforeSupports).toContain("conic-gradient(");
    expect(beforeSupports).toContain("#ff7ab6");
  });

  it("knows every effect the stylesheet defines, so a new one has to be decided", () => {
    // The anti-vacuity guard AND the review prompt. An effect that appears in
    // the CSS and in neither list above is one whose relationship to the colour
    // swatch nobody has stated.
    const defined = new Set(
      [...block.matchAll(/\.icon-effect-([a-z-]+)(?:::|[\s,{])/g)].map((match) => match[1]),
    );
    // The keyframes share the prefix; only the classes are effects.
    for (const name of ["iridescent-a", "iridescent-b"]) defined.delete(name);
    expect([...defined].sort()).toEqual([...COLOUR_LED, ...MOTION_ONLY].sort());
  });
});
