import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The panel previews an icon effect with the cabinet's own CSS, not with a
 * lookalike.
 *
 * WHY A COPY AT ALL. The two apps build from separate directories into separate
 * images; the panel cannot import a stylesheet out of the cabinet's source tree.
 * So the rules exist twice, and the second copy is only worth having while it
 * is exact — an operator tuning a glow against a preview that drifted is being
 * lied to, quietly, and the drift only ever surfaces as "it looked different in
 * the panel". Same argument, and the same arrangement, as the vendored Originkit
 * components and the vendored landing kit.
 *
 * WHY THE NEIGHBOUR IS ALLOWED TO DIFFER. `card-effect-preview-runtime.css` in
 * the panel is deliberately NOT a copy of anything: it stands in for a WebGL
 * shader with a drifting gradient, and no CSS could be faithful to that. It even
 * animates `background-position`, which the cabinet's paint contract forbids —
 * correctly, because that file runs on a desktop and the cabinet runs on a
 * phone. Icon effects are plain CSS, so here the copy can be exact, and nothing
 * excuses it not being.
 *
 * The comparison is over the marked block, so both files may move freely around
 * it. Editing either one alone is what fails.
 */

const CABINET_CSS = fileURLToPath(
  new URL("../../web/src/index.css", import.meta.url),
);
const PANEL_CSS = fileURLToPath(
  new URL(
    "../../../rezeis/rezeis-admin/web/src/features/branding/icon-effects-preview.css",
    import.meta.url,
  ),
);

const BEGIN = "/* icon-effects:begin";
const END = "/* icon-effects:end */";

/** The marked rules, with line endings normalised so a checkout policy cannot fail this. */
function markedBlock(source: string): string {
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  if (from === -1 || to === -1) return "";
  // Past the end of the begin marker's own line.
  const start = source.indexOf("\n", from) + 1;
  return source.slice(start, to).replace(/\r\n/g, "\n").trim();
}

/**
 * The panel's escape hatch, and the ONE thing its copy is allowed to add.
 *
 * An operator whose system asks for reduced motion still has to be able to
 * judge an effect they just clicked — otherwise the panel shows them a still
 * icon and they report the effect as broken, which is what happened. The panel
 * scopes every reduced-motion rule with this so a switch can lift all of them
 * at once, without restating a single duration. A restated duration is a second
 * copy that drifts; a scope is not.
 *
 * The cabinet has no such attribute and must never grow one: a subscriber's
 * setting is not the operator's to override.
 */
const PANEL_MOTION_SCOPE = ":root:not([data-force-icon-motion]) ";

/** Every `.icon-effect-*` line inside a reduced-motion block. */
function reducedMotionIconRules(source: string): readonly string[] {
  const at = source.indexOf("@media (prefers-reduced-motion: reduce) {");
  if (at === -1) return [];
  const block = source.slice(at, source.indexOf("\n}", at));
  return block
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(".icon-effect-"));
}

const hasPanelCopy = existsSync(PANEL_CSS);

describe("icon effect CSS parity with the panel preview", () => {
  const cabinet = readFileSync(CABINET_CSS, "utf8");

  it("marks the block it shares", () => {
    // Anchors everything below: without the markers the extraction returns an
    // empty string, and two empty strings compare equal forever.
    expect(
      cabinet.includes(BEGIN),
      "the `icon-effects:begin` marker is gone from index.css — the parity check below silently compares nothing",
    ).toBe(true);
    expect(cabinet.includes(END)).toBe(true);
    expect(markedBlock(cabinet).length).toBeGreaterThan(500);
  });

  it("names every effect the cabinet defines", () => {
    // A class the cabinet has and the panel does not is an effect an operator
    // can pick and cannot see.
    const block = markedBlock(cabinet);
    for (const effect of ["pulse", "shake", "glow", "glint", "iridescent"]) {
      expect(block, `the cabinet has no rule for .icon-effect-${effect}`).toContain(
        `.icon-effect-${effect}`,
      );
    }
  });

  it.skipIf(!hasPanelCopy)("carries the identical rules in the panel", () => {
    const panel = readFileSync(PANEL_CSS, "utf8");
    // EQUALITY, not containment. `toContain` let the panel copy grow: an extra
    // `.icon-effect-supernova`, or an `!important` override of an existing
    // effect's timing, both passed while the file's whole premise is that the
    // copy is exact.
    const panelBlock = markedBlock(
      panel.includes(BEGIN) ? panel : `${BEGIN}\n${panel}\n${END}`,
    );
    expect(
      panelBlock,
      "the panel's icon-effect CSS has drifted from the cabinet's — regenerate it from the marked block in index.css rather than editing it by hand",
    ).toBe(markedBlock(cabinet));
  });

  it.skipIf(!hasPanelCopy)("stops the same effects under reduced motion", () => {
    // The rules could match exactly and still behave differently, because the
    // cabinet's reduced-motion rules live in a shared block this copy has to
    // lift them out of. A preview that keeps animating for an operator who
    // asked their system for no motion is its own defect.
    const panel = readFileSync(PANEL_CSS, "utf8");
    const panelRules = reducedMotionIconRules(panel);
    // Every one of them carries the scope, so the switch cannot half-work:
    // a rule that forgot it keeps its icon still whatever the operator
    // presses, and would otherwise pass this file by looking identical.
    for (const rule of panelRules) {
      expect(
        rule.startsWith(PANEL_MOTION_SCOPE),
        `this reduced-motion rule ignores the panel's motion switch: ${rule}`,
      ).toBe(true);
    }
    expect(
      panelRules.map((rule) => rule.slice(PANEL_MOTION_SCOPE.length)).sort(),
    ).toEqual([...reducedMotionIconRules(cabinet)].sort());
  });

  it("keeps the panel's escape hatch out of the cabinet", () => {
    // An operator may lift their OWN system setting to judge an effect.
    // Nothing gives them the right to lift a subscriber's.
    expect(
      cabinet.includes("data-force-icon-motion"),
      "the cabinet has grown the panel's motion override — a subscriber's "
        + "reduced-motion setting is not an operator's to lift",
    ).toBe(false);
  });

  it("says out loud when the sibling checkout is absent", () => {
    // CI for this repository has no panel working tree, so the two cases above
    // skip there. That is fine — they run where both trees exist, which is
    // where the copy is actually made — but a silent skip is how a guard stops
    // guarding without anyone noticing.
    console.info(
      hasPanelCopy
        ? `icon-effect CSS parity: comparing against ${PANEL_CSS}`
        : `icon-effect CSS parity: no panel copy at ${PANEL_CSS} — the comparison skips`,
    );
    expect(typeof hasPanelCopy).toBe("boolean");
  });
});
