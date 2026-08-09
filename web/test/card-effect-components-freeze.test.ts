import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CARD_EFFECT_COMPONENTS } from "@/components/reactbits/card-effect-manifest";

/**
 * The cabinet half of the card-effect byte-freeze.
 *
 * Both apps draw the same subscription card. The components under
 * `components/reactbits/` are COPIES: the panel repo is the source, because it
 * is the only tree that can run them — its `gl-stub.ts` and the lifecycle,
 * canvas-ownership and render-scale suites all live there, and nothing in this
 * repository mounts a shader component at all. A change made here first is a
 * change no test anywhere can execute.
 *
 * `rezeis-admin/web/scripts/sync-card-effects.mjs` does the copying and writes
 * `card-effects.manifest.json` into BOTH trees. The panel's own
 * `card-effects-manifest.test.ts` is the other half of this pair.
 *
 * This file exists rather than leaving the whole check over there because the
 * two repositories have separate CI: on the machine that builds this one the
 * panel checkout does not exist, the cross-repo assertion there is
 * `skipIf`-ed away, and a component hand-edited HERE would pass every test this
 * project runs. The manifest travelling with the copy is what closes that.
 *
 * What it cannot catch: identical bytes are not identical behaviour. The two
 * builds resolve `react`, `three` and `ogl` from their own lockfiles and bundle
 * with their own config. Nor does it say anything about the props each app
 * passes — `test/web/card-effect-catalog-parity.test.ts` is what compares those.
 */

const COMPONENT_DIR = fileURLToPath(
  new URL("../src/components/reactbits/", import.meta.url),
);
const MANIFEST_PATH = `${COMPONENT_DIR}card-effects.manifest.json`;
/** `<workspace>/rezeis/rezeis-admin/web/src/components/reactbits/`. */
const PANEL_COMPONENT_DIR = fileURLToPath(
  new URL(
    "../../../rezeis/rezeis-admin/web/src/components/reactbits/",
    import.meta.url,
  ),
);

/**
 * Hash the canonical LF form, matching the sync script.
 *
 * Both repos are checked out with `core.autocrlf=true`, so identical committed
 * content is LF in git and CRLF on disk. Hashing raw bytes would make every
 * assertion below depend on the checkout's line-ending policy.
 */
const sha256 = (text: string): string =>
  createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

interface Manifest {
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly excluded: Record<string, string>;
  readonly files: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const frozen = Object.keys(manifest.files).sort();

describe("frozen card-effect components", () => {
  it("carries a manifest that names its source", () => {
    // Anchors every case below: an emptied manifest would make them all iterate
    // nothing and pass.
    expect(frozen.length).toBeGreaterThanOrEqual(30);
    expect(manifest.sourcePath).toContain("rezeis-admin");
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/);
  });

  it("matches the manifest byte-for-byte (these copies are not hand-editable)", () => {
    const mismatched = frozen.filter(
      (name) => sha256(readFileSync(`${COMPONENT_DIR}${name}`, "utf8")) !== manifest.files[name],
    );
    expect(
      mismatched,
      "a copied component was edited here — edit it in the panel repo and run scripts/sync-card-effects.mjs",
    ).toEqual([]);
  });

  it("draws every frozen component from a card effect, and every card effect it can", () => {
    // Both directions at once, because each catches a different mistake: a
    // frozen file no effect names is dead weight in a subscriber's bundle, and
    // an effect drawn from this directory without being frozen is one that can
    // drift away from the operator's preview.
    const SUPPORT = new Set(["render-scale.ts", "fiber-render-scale.tsx"]);
    const offered = new Set(
      Object.keys(CARD_EFFECT_COMPONENTS).map((id) => id.toLowerCase()),
    );
    const orphans = frozen
      .filter((file) => !SUPPORT.has(file))
      .filter((file) => !offered.has(file.replace(/\.tsx$/, "").toLowerCase()));
    expect(orphans, "frozen components no effect draws").toEqual([]);
  });

  it("states why anything shared is left unfrozen", () => {
    // `paper.tsx` is written per repo in each repo's house style; `Aurora` is
    // drawn here from `components/ui/aurora` instead, eagerly, because it is
    // the default card. Both are decisions, and both are recorded rather than
    // dropped out of a glob.
    expect(Object.keys(manifest.excluded).sort()).toEqual([
      "Aurora.tsx",
      "paper.tsx",
    ]);
  });

  // Cross-repo half: only meaningful where both checkouts sit side by side.
  const hasSibling = existsSync(PANEL_COMPONENT_DIR);
  it.skipIf(!hasSibling)("is in lockstep with the sibling panel checkout", () => {
    const drifted = frozen.filter(
      (name) =>
        existsSync(`${PANEL_COMPONENT_DIR}${name}`) &&
        sha256(readFileSync(`${PANEL_COMPONENT_DIR}${name}`, "utf8")) !== manifest.files[name],
    );
    expect(
      drifted,
      "the panel's components changed after the last sync — run scripts/sync-card-effects.mjs",
    ).toEqual([]);

    const missing = frozen.filter((name) => !existsSync(`${PANEL_COMPONENT_DIR}${name}`));
    expect(missing, "frozen components absent from the panel tree").toEqual([]);
  });
});
