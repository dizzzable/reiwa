/**
 * The cross-repo parity digest: normalisation, hashing, and the message an
 * operator sees when it moves.
 *
 * ── THE PROBLEM THIS ANSWERS ────────────────────────────────────────────────
 * Three specs here guard parity with `rezeis/rezeis-admin` by reading that
 * repository's source text out of a sibling checkout, and they SKIP when it is
 * absent — which, in reiwa's CI, is always. No package is shared between the
 * two repositories and no CI job can see both, so nothing enforced the parity
 * anywhere except on a developer machine that happened to hold both trees.
 *
 * ── THE SHAPE OF THE ANSWER ─────────────────────────────────────────────────
 * Each guarded surface is reduced to a CANONICAL FORM — plain data describing
 * what the two sides must agree on, and nothing else — and a SHA-256 of that
 * form is committed as a literal in BOTH repositories:
 *
 *   reiwa  states it in the spec that guards the surface, and computes it from
 *          `test/support/panel-parity-manifest.ts`, its committed copy of the
 *          panel's half;
 *   rezeis states THE SAME literal in `test/reiwa-parity-digest.spec.ts`, and
 *          computes it from the panel's LIVE sources.
 *
 * So a one-sided edit cannot ship quietly: change the panel and rezeis CI goes
 * red until someone writes a new literal, and the message it prints names the
 * reiwa file and constant that have to change in the same breath.
 *
 * ── WHAT THIS DOES NOT DO, STATED PLAINLY ───────────────────────────────────
 * Neither repository's CI can read the other. If the panel changes AND the
 * rezeis literal is dutifully updated AND reiwa is never touched, both CIs are
 * green and the two repositories now hold different digests for the same
 * surface. Nothing here detects that; only a cross-repo checkout could. What
 * this buys is that the divergence cannot happen by ACCIDENT — it takes an
 * edit to a constant whose failure message asked for the other repository by
 * name — and that the 49 cases which used to skip in CI now run.
 *
 * ── NORMALISATION: MEANING, NOT BYTES ───────────────────────────────────────
 * `canonicalise` sorts object keys and keeps array order. That split is the
 * whole design and it is deliberate in both directions:
 *
 *   KEPT, because a human sees it — every string value, every numeric bound and
 *   slider default, every boolean flag, the set of ids and props, and the ORDER
 *   of arrays. Reordering `MARKUP_UPLOAD_EXTENSIONS` or a picker's option list
 *   is a real change, so it moves the digest.
 *
 *   DROPPED, because nobody sees it — object KEY order (a record is not a list;
 *   the parity specs have always sorted ids before comparing them), comments,
 *   whitespace, line endings, quote style, trailing commas, `as const` /
 *   `satisfies` wrappers, and how a negative number is spelled.
 *
 * Under-normalise and the guard cries wolf on a reflowed comment until someone
 * deletes it; over-normalise and it goes blind. The non-vacuity cases in each
 * spec exist to catch the second failure, which is the silent one: this
 * codebase has already shipped a guard whose regex matched nothing.
 */
import { createHash } from "node:crypto";

/**
 * Deterministic serialisation of the canonical form.
 *
 * Not `JSON.stringify`: that preserves insertion order for object keys, so two
 * sides which agree on every value but wrote them in a different order would
 * hash differently and the guard would fail on nothing.
 */
export function canonicalise(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalise(element)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalise(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256, hex, of the canonical form of `value`. */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalise(value), "utf8").digest("hex");
}

/**
 * `sha256("")`.
 *
 * Pinned so every spec can assert its surface does NOT hash to it. A
 * normalisation that swallowed its input, or a reader that returned nothing,
 * lands exactly here — and would otherwise agree with itself forever.
 */
export const EMPTY_INPUT_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** `digestOf({})` — the other shape a vacuous read takes. */
export const EMPTY_OBJECT_DIGEST =
  "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

/** `digestOf([])`. */
export const EMPTY_ARRAY_DIGEST =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

/**
 * A fixture with a known canonical form, so the two properties this file
 * depends on can be pinned rather than assumed: object keys are SORTED (`a`
 * before `b`, `c` before `d`) and array order is KEPT (`1` before `"x"`).
 *
 * A canonicaliser that dropped values, flattened structure or sorted arrays
 * would still produce a stable digest for every real surface — and would be
 * blind. This is what notices.
 */
export const CANONICAL_FIXTURE = { b: [1, "x"], a: { d: true, c: null } };
export const CANONICAL_FIXTURE_FORM = '{"a":{"c":null,"d":true},"b":[1,"x"]}';
export const CANONICAL_FIXTURE_DIGEST =
  "49bd9631390b56109ef9a77080d397067fdd5bfde2d9f67de64a11d73af2e3d3";

/** Where a surface's digest is written down, on each side. */
export interface ParitySurface {
  /** What the surface is, in one phrase, for the first line of the message. */
  readonly title: string;
  /** The panel file(s) the canonical form is read out of. */
  readonly panelSources: readonly string[];
  /** `CONSTANT` in `path` — reiwa's copy. */
  readonly reiwaConstant: string;
  readonly reiwaFile: string;
  /** `CONSTANT` in `path` — the panel's copy. */
  readonly rezeisConstant: string;
  readonly rezeisFile: string;
}

/**
 * The message printed when a digest moves.
 *
 * It has to carry a REMEDY. A digest mismatch with no remedy is a puzzle: the
 * reader is shown two hex strings and left to work out which of two
 * repositories moved, which file did it, and what to do about it. So the
 * message names the sources that feed the digest, the new value to write, and
 * — the part that is easy to omit and is the entire point — the constant in the
 * OTHER repository that has to change in the same commit.
 */
export function digestDriftMessage(
  surface: ParitySurface,
  computed: string,
  side: "reiwa" | "rezeis",
): string {
  const own = side === "reiwa" ? surface.reiwaConstant : surface.rezeisConstant;
  const ownFile = side === "reiwa" ? surface.reiwaFile : surface.rezeisFile;
  const other = side === "reiwa" ? surface.rezeisConstant : surface.reiwaConstant;
  const otherFile = side === "reiwa" ? surface.rezeisFile : surface.reiwaFile;
  const otherRepo = side === "reiwa" ? "rezeis-admin" : "reiwa";
  return [
    `${surface.title}: the committed digest no longer matches the content it is over.`,
    ``,
    `  computed now: ${computed}`,
    ``,
    `Something in one of these changed:`,
    ...surface.panelSources.map((source) => `  - ${source}`),
    ``,
    `TO FIX, IN ONE CHANGE, ON BOTH SIDES:`,
    `  1. confirm the change above is intended — this digest is the only thing`,
    `     that makes a one-sided edit to this surface visible;`,
    `  2. set ${own} = "${computed}"`,
    `     in ${ownFile};`,
    `  3. set ${other} to the SAME value`,
    `     in ${otherRepo}'s ${otherFile},`,
    `     and mirror the content change itself there.`,
    ``,
    `Step 3 is not optional and nothing else enforces it: neither repository's`,
    `CI can read the other. Skip it and the two halves of this policy drift`,
    `apart with both pipelines green.`,
  ].join("\n");
}

/** The three surfaces, described once so both repositories can quote them. */
export const UPLOAD_POLICY_SURFACE: ParitySurface = {
  title: "The rezeis /uploads header policy",
  panelSources: [
    "rezeis-admin/src/main.ts — MARKUP_UPLOAD_EXTENSIONS, applyUploadResponseHeaders",
    "reiwa/test/support/panel-parity-manifest.ts — PANEL_UPLOAD_POLICY",
  ],
  reiwaConstant: "UPLOAD_POLICY_DIGEST",
  reiwaFile: "reiwa/test/api/upload-relay-headers.test.ts",
  rezeisConstant: "UPLOAD_POLICY_DIGEST",
  rezeisFile: "rezeis-admin/test/reiwa-parity-digest.spec.ts",
};

export const CARD_EFFECT_SURFACE: ParitySurface = {
  title: "The card effect catalog parity surface",
  panelSources: [
    "rezeis-admin/web/src/features/branding/card-effect-catalog.ts — CARD_EFFECT_CATALOG",
    "reiwa/test/support/panel-parity-manifest.ts — PANEL_CARD_EFFECTS",
  ],
  reiwaConstant: "CARD_EFFECT_PARITY_DIGEST",
  reiwaFile: "reiwa/test/web/card-effect-catalog-parity.test.ts",
  rezeisConstant: "CARD_EFFECT_PARITY_DIGEST",
  rezeisFile: "rezeis-admin/test/reiwa-parity-digest.spec.ts",
};

export const BRANDING_VOCABULARY_SURFACE: ParitySurface = {
  title: "The branding vocabularies",
  panelSources: [
    "rezeis-admin/src/modules/settings/interfaces/branding-settings.interface.ts",
    "rezeis-admin/src/modules/settings/dto/update-branding-settings.dto.ts",
    "rezeis-admin/web/src/features/branding/branding-form-schema.ts",
    "reiwa/test/support/panel-parity-manifest.ts — PANEL_BRANDING_VOCABULARY",
  ],
  reiwaConstant: "BRANDING_VOCABULARY_DIGEST",
  reiwaFile: "reiwa/test/web/branding-vocabulary-panel-parity.test.ts",
  rezeisConstant: "BRANDING_VOCABULARY_DIGEST",
  rezeisFile: "rezeis-admin/test/reiwa-parity-digest.spec.ts",
};
