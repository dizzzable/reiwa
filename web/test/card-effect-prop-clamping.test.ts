import { describe, expect, it } from "vitest";

import { CARD_EFFECT_CATALOG } from "../src/components/reactbits/card-effect-catalog";
import {
  CARD_EFFECT_NUMERIC_BOUNDS,
  cardEffectNumericBounds,
  clampCardEffectProps,
} from "../src/components/reactbits/card-effect-bounds";

/**
 * An operator's numbers must not be able to melt a subscriber's phone.
 *
 * `cardEffectProps` is authored with sliders, but the value that reaches this
 * renderer has crossed a backend that bounds the JSON's shape and never its
 * numbers, and it can also arrive from a hand-edited row, a direct API call or
 * a config restored from an older install. `beamNumber: 300` is not a cosmetic
 * mistake — it is three hundred full-screen transparent planes on a device
 * whose fill rate was already the constraint.
 *
 * Two properties are asserted here and they pull against each other, which is
 * the point: the clamp must CATCH every out-of-range number, and it must be
 * completely invisible to every in-range one. Either alone is trivial to
 * satisfy — a clamp that rewrote everything passes the first, a clamp that did
 * nothing passes the second.
 */

type Bounds = typeof CARD_EFFECT_NUMERIC_BOUNDS;

const BOUNDED_EFFECTS = Object.keys(CARD_EFFECT_NUMERIC_BOUNDS) as (keyof Bounds)[];

/** Every `[effectId, prop, min, max]` this build declares. */
const EVERY_RANGE: readonly (readonly [string, string, number, number])[] =
  BOUNDED_EFFECTS.flatMap((effect) =>
    Object.entries(
      CARD_EFFECT_NUMERIC_BOUNDS[effect] as Record<
        string,
        readonly [number, number]
      >,
    ).map(
      ([prop, [min, max]]) => [effect, prop, min, max] as const,
    ),
  );

describe("card effect numeric bounds table", () => {
  it("declares a range for every effect this bundle can draw", () => {
    // An effect added to the catalog with no bounds mirrored is an effect whose
    // props reach the GPU unchecked, and nothing else in this file would say
    // so: every case below iterates the bounds table, so an id missing from it
    // is an id no case visits.
    expect(BOUNDED_EFFECTS.length).toBeGreaterThan(20);
    expect([...BOUNDED_EFFECTS].sort()).toEqual(
      Object.keys(CARD_EFFECT_CATALOG).sort(),
    );
  });

  it("declares every range with a minimum below its maximum", () => {
    expect(EVERY_RANGE.length).toBeGreaterThan(200);
    const inverted = EVERY_RANGE.filter(([, , min, max]) => !(min < max)).map(
      ([effect, prop, min, max]) => `${effect}.${prop}: [${min}, ${max}]`,
    );

    expect(inverted).toEqual([]);
  });

  it("keeps every shipped default inside its own declared range", () => {
    // The catalog's defaults are what a card draws when the operator has
    // changed nothing. A mirrored range that excludes one of them would move
    // the shipped picture on every install the moment this clamp landed.
    const escaped = Object.entries(CARD_EFFECT_CATALOG).flatMap(
      ([effect, entry]) =>
        Object.entries(entry.defaults as Record<string, unknown>)
          .filter(([prop, value]) => {
            const range = cardEffectNumericBounds(effect)?.[prop];
            return (
              typeof value === "number" &&
              range !== undefined &&
              (value < range[0] || value > range[1])
            );
          })
          .map(
            ([prop, value]) =>
              `${effect}.${prop}: default ${String(value)} outside ${JSON.stringify(cardEffectNumericBounds(effect)?.[prop])}`,
          ),
    );

    expect(escaped).toEqual([]);
  });
});

describe("clampCardEffectProps leaves in-range configurations alone", () => {
  it.each(EVERY_RANGE)(
    "returns the very object it was given for %s.%s at both ends and inside",
    (effect, prop, min, max) => {
      // Referential identity, not deep equality: it is the strongest available
      // statement of "invisible", it is what the memoised children downstream
      // depend on, and unlike `toEqual` it cannot be satisfied by a copy that
      // happens to hold the same numbers.
      for (const value of [
        min,
        max,
        (min + max) / 2,
        min + (max - min) / 3,
        max - (max - min) / 7,
      ]) {
        const props = { [prop]: value };

        expect(
          clampCardEffectProps(effect, props),
          `${effect}.${prop} = ${value} is inside [${min}, ${max}] and must pass through untouched`,
        ).toBe(props);
      }
    },
  );

  it("passes a whole effect's shipped defaults through as the same object", () => {
    const untouched = Object.entries(CARD_EFFECT_CATALOG)
      .map(([effect, entry]) => [effect, entry.defaults] as const)
      .filter(([, defaults]) => Object.keys(defaults).length > 0);
    expect(untouched.length).toBeGreaterThan(10);

    for (const [effect, defaults] of untouched) {
      expect(
        clampCardEffectProps(effect, defaults),
        `the shipped defaults for ${effect} must survive the clamp untouched`,
      ).toBe(defaults);
    }
  });
});

describe("clampCardEffectProps pins what left the panel's range", () => {
  it("pins a value above the ceiling to the ceiling", () => {
    // The report this exists for: a slider that stops at 30 beams, a stored
    // 300, and thirty times the fill rate on a phone.
    expect(clampCardEffectProps("beams", { beamNumber: 300 })).toEqual({
      beamNumber: 30,
    });
  });

  it("pins a value below the floor to the floor", () => {
    expect(clampCardEffectProps("beams", { beamNumber: -50 })).toEqual({
      beamNumber: 4,
    });
  });

  it("pins every declared range at both ends", () => {
    // One case per range rather than per effect: a ceiling mirrored from the
    // wrong slider is still a ceiling, and only the value proves which.
    const wrong: string[] = [];
    for (const [effect, prop, min, max] of EVERY_RANGE) {
      const span = Math.max(max - min, 1);
      const above = clampCardEffectProps(effect, { [prop]: max + span * 10 });
      const below = clampCardEffectProps(effect, { [prop]: min - span * 10 });
      if (above[prop] !== max) {
        wrong.push(`${effect}.${prop}: above the range became ${String(above[prop])}, want ${max}`);
      }
      if (below[prop] !== min) {
        wrong.push(`${effect}.${prop}: below the range became ${String(below[prop])}, want ${min}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it("clamps only the offending prop and keeps the rest of the record", () => {
    const result = clampCardEffectProps("beams", {
      beamNumber: 300,
      lightColor: "#ffffff",
      speed: 2,
    });

    expect(result).toEqual({
      beamNumber: 30,
      lightColor: "#ffffff",
      speed: 2,
    });
  });

  it("does not mutate the record it was given", () => {
    const props: Record<string, unknown> = { beamNumber: 300 };

    clampCardEffectProps("beams", props);

    expect(props["beamNumber"]).toBe(300);
  });
});

describe("clampCardEffectProps drops what is not a number at all", () => {
  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("removes a %s so a declared default can apply", (_label, value) => {
    const result = clampCardEffectProps("beams", { beamNumber: value });

    expect(Object.hasOwn(result, "beamNumber")).toBe(false);
  });

  it("lets the catalog default win once a non-finite value has been removed", () => {
    // Removal only means anything in composition with the merge the layer
    // performs, and this is that composition: defaults UNDER the clamped
    // operator record. Clamping after the merge would delete the default too.
    const merged = {
      ...CARD_EFFECT_CATALOG.beams.defaults,
      ...clampCardEffectProps("beams", { beamNumber: Number.NaN }),
    };

    expect(merged["beamNumber"]).toBe(12);
  });
});

describe("clampCardEffectProps degrades rather than blanks", () => {
  it("passes an effect it has never heard of through as the same object", () => {
    // rezeis-admin may legitimately be a release ahead. An unknown effect's
    // props must not be edited on a guess.
    const props = { beamNumber: 300 };

    expect(clampCardEffectProps("an-effect-from-a-newer-panel", props)).toBe(props);
  });

  it.each(["toString", "constructor", "hasOwnProperty"])(
    "is not fooled by the inherited effect name %s",
    (inherited) => {
      // `'toString' in BOUNDS` is true, and the lookup after it would hand a
      // function where a table of ranges was expected.
      const props = { beamNumber: 300 };

      expect(clampCardEffectProps(inherited, props)).toBe(props);
    },
  );

  it.each(["toString", "constructor", "valueOf"])(
    "is not fooled by a prop literally named %s",
    (inherited) => {
      // Same trap one level down: the per-effect range table is an object
      // literal too, so an operator prop named `toString` must not read as a
      // declared range either.
      const props = { [inherited]: 300 };

      expect(clampCardEffectProps("beams", props)).toBe(props);
    },
  );

  it("leaves a prop with no declared range untouched", () => {
    // `spinRotation` is a real balatro prop this bundle configures, and the
    // panel gives it no slider. No range means no opinion.
    const props = { spinRotation: -2000 };

    expect(clampCardEffectProps("balatro", props)).toBe(props);
  });

  it.each([
    ["a string", "300"],
    ["null", null],
    ["a boolean", true],
    ["an array", [1, 2, 3]],
    ["an object", { value: 300 }],
  ])("leaves %s under a bounded prop name untouched", (_label, value) => {
    // Non-numeric props are somebody else's problem — the components' own
    // parsing, and `sanitizeCardEffectProps` for the dangerous names. Coercing
    // one here would invent a number the operator never wrote.
    const props = { beamNumber: value };

    expect(clampCardEffectProps("beams", props)).toBe(props);
  });

  it("treats a negative zero against a zero floor as already in range", () => {
    const props = { noiseIntensity: -0 };

    expect(clampCardEffectProps("beams", props)).toBe(props);
  });
});
