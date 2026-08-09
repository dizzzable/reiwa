import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CARD_EFFECT_CATALOG,
  type CardEffectEntry,
} from "@/components/reactbits/card-effect-catalog";
import {
  CARD_EFFECT_NUMERIC_BOUNDS,
  clampCardEffectProps,
} from "@/components/reactbits/card-effect-bounds";

/**
 * The cabinet's catalog and the panel's catalog must describe the same effects.
 *
 * There are two of them because they answer to different builds and carry
 * different payloads: the panel's entry knows the operator-facing name and the
 * controls that tune the effect, the cabinet's knows the props to apply and
 * nothing about a form. Neither file can import the other. What they must
 * nevertheless agree on is the part a subscriber can see:
 *
 *  - the set of effect ids, because an effect the panel offers and the cabinet
 *    has never heard of renders as NOTHING on that subscriber's card. That
 *    silence cannot be caught over in the cabinet: every test there asks the
 *    cabinet about ids the cabinet declares, and for an unknown id drawing
 *    nothing IS the specified behaviour — the suite certifies the silence;
 *  - `renderer`, because it decides whether the effect is even attempted on a
 *    given device. Filed as `webgl2` on one side and `canvas2d` on the other,
 *    an effect the operator previewed happily is skipped on the phone that
 *    could have drawn it, or attempted on one that cannot;
 *  - `fullOutputGamut`, because it is the input to the card's text-contrast
 *    analysis. Set on one side only, the two builds compute different contrast
 *    for the same card and the operator is shown a legibility verdict the
 *    subscriber's device does not share.
 *
 *  - the min/max of every numeric SLIDER, because the cabinet clamps operator
 *    numbers to those ranges before handing them to a renderer and it cannot
 *    read the panel's file to learn them. `card-effect-bounds.ts` is a mirror
 *    of exactly these numbers, and a mirror nobody checks is a second source of
 *    truth wearing a disguise: the panel would go on offering 30 beams while
 *    the cabinet pinned them at 12, and the operator's card would differ from
 *    the operator's preview with nothing to say why.
 *
 * `palette`, `defaults` and the rest of a `controls` entry are deliberately NOT
 * compared. The panel derives its defaults from control definitions that exist
 * only to render a form, and its palette is a preview swatch; the cabinet's
 * palette feeds contrast analysis of the real card. They are allowed to differ,
 * and requiring them to match would make this test fail on changes that harm
 * nobody. `step` is not compared for the same reason it is not mirrored: it is
 * how a slider moves, not what a value may be.
 *
 * The panel's file is read with the TypeScript parser rather than a regular
 * expression: a text pattern can silently miss an entry written on one line, or
 * with a quoted key, or with a comment after the brace, and a comparison that
 * silently drops an id from ONE side is exactly the failure this test exists to
 * prevent. The AST sees what the compiler sees.
 */

/** The sibling checkout itself: `<workspace>/rezeis/rezeis-admin/`. */
const PANEL_REPO_URL = new URL("../../../rezeis/rezeis-admin/", import.meta.url);
const PANEL_CATALOG_URL = new URL(
  "web/src/features/branding/card-effect-catalog.ts",
  PANEL_REPO_URL,
);
const PANEL_REPO_PATH = fileURLToPath(PANEL_REPO_URL);
const PANEL_CATALOG_PATH = fileURLToPath(PANEL_CATALOG_URL);

interface PanelSlider {
  readonly min: number;
  readonly max: number;
  readonly default: number | null;
}

interface PanelEntry {
  readonly renderer: string;
  readonly fullOutputGamut: boolean;
  /** Every `type: 'slider'` control, keyed by the prop it drives. */
  readonly sliders: ReadonlyMap<string, PanelSlider>;
}

/** Strip `satisfies` / `as` / parentheses to reach the literal underneath. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The numeric value of a literal, including a negated one.
 *
 * `-90` is a prefix-unary expression over `90`, not a numeric literal, and
 * several sliders (`rotation`, `angle`, `tilt`, `paletteBias`) open below zero.
 * Reading only `NumericLiteral` would silently drop their minima, and a range
 * this parser cannot see is a range the comparison below cannot guard.
 */
function numberOf(node: ts.Expression): number | null {
  const value = unwrap(node);
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken
  ) {
    const operand = unwrap(value.operand);
    if (ts.isNumericLiteral(operand)) return -Number(operand.text);
  }
  return null;
}

function readPanelSliders(
  id: string,
  controls: ts.ArrayLiteralExpression,
): Map<string, PanelSlider> {
  const sliders = new Map<string, PanelSlider>();
  for (const element of controls.elements) {
    const control = unwrap(element);
    if (!ts.isObjectLiteralExpression(control)) continue;

    let prop: string | null = null;
    let type: string | null = null;
    let min: number | null = null;
    let max: number | null = null;
    let fallback: number | null = null;
    for (const field of control.properties) {
      if (!ts.isPropertyAssignment(field)) continue;
      const fieldName = keyText(field.name);
      const value = unwrap(field.initializer);
      if (fieldName === "prop" && ts.isStringLiteral(value)) prop = value.text;
      else if (fieldName === "type" && ts.isStringLiteral(value)) type = value.text;
      else if (fieldName === "min") min = numberOf(value);
      else if (fieldName === "max") max = numberOf(value);
      else if (fieldName === "default") fallback = numberOf(value);
    }
    if (type !== "slider" || prop === null) continue;

    // Refused rather than skipped, on the same principle as the entry loop: a
    // slider whose bounds this cannot read would drop out of the comparison in
    // silence, and silence is what the mirror must never be checked with.
    expect(
      min !== null && max !== null,
      `panel slider '${id}.${prop}' declares no numeric min/max this test can read`,
    ).toBe(true);
    sliders.set(prop, { min: min!, max: max!, default: fallback });
  }
  return sliders;
}

function keyText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function readPanelCatalog(): Map<string, PanelEntry> {
  const source = ts.createSourceFile(
    PANEL_CATALOG_PATH,
    readFileSync(PANEL_CATALOG_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );

  let literal: ts.ObjectLiteralExpression | null = null;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== "CARD_EFFECT_CATALOG") continue;
      if (!declaration.initializer) continue;
      const candidate = unwrap(declaration.initializer);
      if (ts.isObjectLiteralExpression(candidate)) literal = candidate;
    }
  }
  expect(
    literal,
    `no CARD_EFFECT_CATALOG object literal in ${PANEL_CATALOG_PATH}`,
  ).not.toBeNull();

  const entries = new Map<string, PanelEntry>();
  for (const property of literal!.properties) {
    // Refused rather than skipped: a shape this cannot name is an effect that
    // would drop out of the comparison in silence, which is the whole problem.
    expect(
      ts.isPropertyAssignment(property),
      `panel catalog holds a ${ts.SyntaxKind[property.kind]}; it must stay a flat record of literal entries`,
    ).toBe(true);
    const assignment = property as ts.PropertyAssignment;
    const id = keyText(assignment.name);
    expect(id, `panel catalog entry has a key this test cannot read`).not.toBeNull();

    const value = unwrap(assignment.initializer);
    expect(
      ts.isObjectLiteralExpression(value),
      `panel catalog entry '${id}' is not an object literal`,
    ).toBe(true);

    let renderer: string | null = null;
    let fullOutputGamut = false;
    let sliders = new Map<string, PanelSlider>();
    for (const field of (value as ts.ObjectLiteralExpression).properties) {
      if (!ts.isPropertyAssignment(field)) continue;
      const fieldName = keyText(field.name);
      if (fieldName === "renderer") {
        const literalValue = unwrap(field.initializer);
        if (ts.isStringLiteral(literalValue)) renderer = literalValue.text;
      } else if (fieldName === "fullOutputGamut") {
        fullOutputGamut = unwrap(field.initializer).kind === ts.SyntaxKind.TrueKeyword;
      } else if (fieldName === "controls") {
        const controls = unwrap(field.initializer);
        expect(
          ts.isArrayLiteralExpression(controls),
          `panel catalog entry '${id}' does not declare its controls as an array literal`,
        ).toBe(true);
        sliders = readPanelSliders(id!, controls as ts.ArrayLiteralExpression);
      }
    }
    expect(renderer, `panel catalog entry '${id}' declares no string renderer`).not.toBeNull();
    entries.set(id!, { renderer: renderer!, fullOutputGamut, sliders });
  }
  return entries;
}

// Only meaningful on a machine holding both checkouts side by side, which is
// the working setup here. reiwa's CI clones reiwa alone, so there these cases
// skip.
//
// A skipped guard guards nothing, so the skip is made as narrow as it can be:
// it is allowed ONLY when the whole sibling repository is absent. If the repo
// is there and the catalog is not, the file moved or was renamed, and the case
// below turns that into a red test instead of a silent skip that would go on
// reporting "skipped" for as long as it took anyone to notice.
const hasSiblingRepo = existsSync(PANEL_REPO_PATH);
const hasSibling = existsSync(PANEL_CATALOG_PATH);

/**
 * The catalog is declared with `satisfies`, so each entry keeps its literal
 * type and `fullOutputGamut` is absent from the ones that do not set it. Read
 * the entries at the type the catalog is declared to satisfy — the same view
 * the cabinet's own accessors take — rather than widening anything.
 */
const cabinetEntries = (): readonly (readonly [string, CardEffectEntry])[] =>
  Object.entries(CARD_EFFECT_CATALOG) as (readonly [string, CardEffectEntry])[];

describe("card effect catalog parity with the rezeis-admin panel", () => {
  it("finds the panel catalog wherever the sibling checkout exists", () => {
    // Not an assertion about parity — an assertion about this file's own reach,
    // and the only case here that always runs. It says in the log which of the
    // two modes the run is in, and it fails outright in the one situation a
    // skip would be a lie: the sibling repo is present but its catalog is not
    // where this test looks.
    console.info(
      hasSibling
        ? `card-effect parity: reading the panel catalog at ${PANEL_CATALOG_PATH}`
        : `card-effect parity: no sibling checkout at ${PANEL_REPO_PATH} — parity cases skip`,
    );
    expect(Object.keys(CARD_EFFECT_CATALOG).length).toBeGreaterThan(20);

    if (hasSiblingRepo) {
      expect(
        hasSibling,
        `the rezeis-admin checkout is at ${PANEL_REPO_PATH} but its card effect catalog is not at ${PANEL_CATALOG_PATH} — it moved, and every parity case below is skipping instead of guarding`,
      ).toBe(true);
    }
  });

  it.skipIf(!hasSibling)("offers exactly the same effect ids", () => {
    const panel = [...readPanelCatalog().keys()].sort();
    const cabinet = Object.keys(CARD_EFFECT_CATALOG).sort();

    // Anchors both sides: without it a parse that returned nothing would
    // compare an empty list to an empty list on the day the file's shape
    // changed, and pass while guarding nothing.
    expect(panel.length).toBeGreaterThan(20);
    expect(cabinet.length).toBeGreaterThan(20);

    expect(
      panel,
      "the panel offers effects the cabinet cannot draw, or the cabinet draws effects the panel cannot offer",
    ).toEqual(cabinet);
  });

  it.skipIf(!hasSibling)("agrees on the renderer each effect needs", () => {
    const panel = readPanelCatalog();
    const shared = cabinetEntries().filter(([id]) => panel.has(id));
    expect(shared.length).toBeGreaterThan(20);

    const disagreements = shared
      .filter(([id, entry]) => panel.get(id)!.renderer !== entry.renderer)
      .map(([id, entry]) => `${id}: panel=${panel.get(id)!.renderer} cabinet=${entry.renderer}`);

    expect(disagreements).toEqual([]);
  });

  it.skipIf(!hasSibling)("mirrors every slider range the panel declares", () => {
    const panel = readPanelCatalog();
    const mirrored: Readonly<
      Record<string, Readonly<Record<string, readonly [number, number]>>>
    > = CARD_EFFECT_NUMERIC_BOUNDS;

    // Both sides are flattened to `effect.prop: [min, max]` strings and
    // compared as whole sorted lists rather than key by key. A per-key loop
    // over one side can only find disagreements about keys that side has; this
    // shape reports a range the panel added and the mirror never got, a range
    // the mirror invented, and a range whose numbers moved, in one diff.
    const flatten = (
      source: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
      range: (entry: unknown) => readonly [number, number],
    ): string[] =>
      Object.entries(source)
        .flatMap(([id, props]) =>
          Object.entries(props).map(([prop, value]) => {
            const [min, max] = range(value);
            return `${id}.${prop}: [${min}, ${max}]`;
          }),
        )
        .sort();

    const fromPanel = flatten(
      Object.fromEntries(
        [...panel].map(([id, entry]) => [id, Object.fromEntries(entry.sliders)]),
      ),
      (entry) => {
        const slider = entry as PanelSlider;
        return [slider.min, slider.max];
      },
    );
    const fromCabinet = flatten(mirrored, (entry) => entry as readonly [number, number]);

    // Anchors both sides: a parse that returned nothing would otherwise compare
    // an empty list to an empty list on the day the panel's file changed shape,
    // and pass while guarding nothing.
    expect(fromPanel.length).toBeGreaterThan(200);
    expect(fromCabinet.length).toBeGreaterThan(200);

    expect(
      fromCabinet,
      "card-effect-bounds.ts has drifted from the panel's sliders — the cabinet would clamp an operator's card to a range the panel no longer offers",
    ).toEqual(fromPanel);
  });

  it.skipIf(!hasSibling)("clamps none of the panel's own slider defaults", () => {
    const panel = readPanelCatalog();

    // Every default the panel ships, through the real clamp. This is the
    // widest available statement that the clamp is invisible: the cabinet's own
    // catalog carries defaults for barely half these effects, and the originkit
    // entries carry none at all by design, so the panel is the only place all
    // of them exist in one file.
    const moved: string[] = [];
    let checked = 0;
    for (const [id, entry] of panel) {
      const defaults: Record<string, unknown> = {};
      for (const [prop, slider] of entry.sliders) {
        if (slider.default === null) continue;
        defaults[prop] = slider.default;
        checked += 1;
      }
      if (Object.keys(defaults).length === 0) continue;

      const clamped = clampCardEffectProps(id, defaults);
      // The same identity check the unit suite makes, applied to values this
      // build has no other way to see. A copy holding equal numbers would mean
      // the clamp had decided something about a default, which it must not.
      if (clamped !== defaults) {
        for (const [prop, value] of Object.entries(defaults)) {
          if (clamped[prop] !== value) {
            moved.push(`${id}.${prop}: ${String(value)} → ${String(clamped[prop])}`);
          }
        }
        if (moved.length === 0) moved.push(`${id}: reallocated without changing a value`);
      }
    }

    expect(checked).toBeGreaterThan(200);
    expect(
      moved,
      "the cabinet clamps a value the panel ships as a slider default — every card on that setting would change appearance",
    ).toEqual([]);
  });

  it.skipIf(!hasSibling)("agrees on which effects escape their palette", () => {
    const panel = readPanelCatalog();
    const shared = cabinetEntries().filter(([id]) => panel.has(id));
    expect(shared.length).toBeGreaterThan(20);

    const disagreements = shared
      .filter(
        ([id, entry]) =>
          panel.get(id)!.fullOutputGamut !== (entry.fullOutputGamut === true),
      )
      .map(
        ([id, entry]) =>
          `${id}: panel=${panel.get(id)!.fullOutputGamut} cabinet=${entry.fullOutputGamut === true}`,
      );

    expect(disagreements).toEqual([]);
  });
});
