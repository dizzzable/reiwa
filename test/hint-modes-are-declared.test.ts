import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE CABINET'S CLAIM ABOUT ITSELF, CHECKED AGAINST THE CABINET.
 *
 * The BFF tells the panel which pop-up modes this image can draw, and the panel
 * holds back every hint whose mode is not on that list. That is what stops a
 * newer panel sending a mode this build would meet with `closeHint(…,
 * 'dismissed')` — a delivery destroyed unshown, and for a once-only hint such
 * as "your trial has started", destroyed permanently.
 *
 * Which makes the declaration load-bearing in BOTH directions, and wrong in
 * opposite ways:
 *
 *   TOO NARROW — a mode the controller draws is missing, so the panel holds
 *   those hints back for ever and the operator's pop-up never arrives. Quiet.
 *
 *   TOO WIDE — a mode is claimed before the controller can draw it, which
 *   re-creates the exact destruction the declaration was written to prevent,
 *   this time caused from our own side.
 *
 * Two files, in two build trees (server and browser), that nothing else
 * compares. A source scan rather than a run, because the controller's branch is
 * inside a React component driven by a fetch; the property worth pinning is
 * that the two lists agree, and that is legible in the text.
 */

const root = resolve(__dirname, "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

/** What the BFF tells the panel. */
function declaredModes(): string[] {
  const source = read("src/api/routes/user-hints.ts");
  const block = /const DRAWABLE_HINT_MODES = \[([^\]]*)\]/.exec(source);
  expect(block, "DRAWABLE_HINT_MODES is gone from the hints route").not.toBeNull();
  return Array.from((block as RegExpExecArray)[1].matchAll(/"([A-Z_]+)"/g), (match) => match[1]);
}

/**
 * What the controller draws.
 *
 * Read as the set of modes it compares itself against, plus MODAL, which is its
 * fall-through. Deliberately not a list maintained here: a third copy would be
 * a third thing to disagree.
 */
function drawnModes(): string[] {
  const source = read("web/src/features/hints/hint-controller.tsx");
  const modes = new Set<string>();
  for (const match of source.matchAll(/mode === ["']([A-Z_]+)["']/g)) modes.add(match[1]);
  for (const match of source.matchAll(/mode !== ["']([A-Z_]+)["']/g)) modes.add(match[1]);
  return [...modes];
}

/**
 * The text from `marker` to the brace that closes what it opened.
 *
 * Counting braces rather than looking for an indented closing brace: a
 * function whose RETURN TYPE is written across several lines closes that type
 * with exactly the same two-space brace the naive search was looking for, so
 * the region came back as the signature alone and every negative assertion
 * over it was vacuous.
 */
/**
 * The text from `marker` to the bracket that closes the one it ends with.
 *
 * The marker must END with the opening bracket, and the count runs on that
 * bracket alone. Both halves matter: an earlier attempt counted `(` and `{`
 * together and, given `function audienceOf(`, returned the parameter list; the
 * attempt before that looked for a newline followed by an indented closing
 * brace and stopped at the close of the multi-line RETURN TYPE, handing back
 * 161 characters of signature. Every negative assertion over either region was
 * satisfied by a region that could not contain the thing being forbidden.
 */
function bracketed(source: string, marker: string, from = 0): string {
  const start = source.indexOf(marker, from);
  if (start < 0) return "";
  const open = marker[marker.length - 1];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

describe("the modes this cabinet declares to the panel", () => {
  it("were found in both files at all", () => {
    // Anti-emptiness anchor. Two empty sets agree with each other, and that
    // agreement would be this file passing while watching nothing.
    expect(declaredModes().length, declaredModes().join(", ")).toBeGreaterThanOrEqual(2);
    expect(drawnModes().length, drawnModes().join(", ")).toBeGreaterThanOrEqual(2);
  });

  it("are exactly the ones the controller draws", () => {
    expect(
      declaredModes().slice().sort(),
      "the BFF's claim and the controller's branches have drifted apart",
    ).toEqual(drawnModes().slice().sort());
  });

  it("always include MODAL, which every cabinet has drawn since the first", () => {
    // The panel treats a missing declaration as MODAL. A build that dropped it
    // from the list would be claiming LESS than a cabinet that says nothing —
    // and would stop receiving the hints it can definitely draw.
    expect(declaredModes()).toContain("MODAL");
  });

  it("reaches the panel on the ask, as a HEADER", () => {
    // The list is worth nothing unless it is sent — and it must not be sent in
    // the BODY. The panel validates bodies with `forbidNonWhitelisted`, so a
    // panel that has not learned the field answers 400 rather than ignoring it,
    // and this route swallows that into `{ hint: null }` at debug level: a
    // cabinet upgraded before its panel would show nobody a single hint, with
    // nothing anywhere saying why.
    const source = read("src/api/routes/user-hints.ts");

    expect(source, "the modes are not sent at all").toContain("[...DRAWABLE_HINT_MODES]");
    expect(source, "audienceOf is no longer what the next call sends").toContain(
      "...audienceOf(req)",
    );

    // In the body, an unknown field is a 400 from an older panel. The audience
    // object is what becomes the body, so the modes must not be inside it.
    //
    // THE SLICE IS BRACE-MATCHED, and the naive one was the whole defect here.
    // Searching for a newline followed by an indented closing brace finds the
    // close of `audienceOf`'s multi-line RETURN TYPE, not of its body — 161
    // characters that stop at the signature. The region this case scanned could
    // not contain the returned object at all, so it was satisfied by any body
    // whatsoever, including one carrying `modes`.
    // The OBJECT audienceOf returns — which is literally what becomes the
    // request body — rather than the function around it.
    const audienceAt = source.indexOf("function audienceOf(");
    expect(audienceAt, "audienceOf is gone").toBeGreaterThan(-1);
    const audience = bracketed(source, "return {", audienceAt);
    expect(audience, "the slice missed the returned object").toContain("surface");
    expect(audience, "the slice missed the returned object").toContain("locale");
    expect(audience, "the modes are back in the request body").not.toContain("modes");

    // AND THE CALL SITE, which the region above cannot see either. The modes
    // would be added where the request is built, and the assertion at the top
    // of this case — that the spread appears somewhere — is satisfied wherever
    // it lands. The body is the FIRST argument and the header list is the
    // SECOND; anything else is the 400.
    const call = bracketed(source, "adminClient.userHints.next(");
    // Brace-matched, not cut at the first comma: the first argument IS an
    // object literal with commas inside it, so a naive cut lands three
    // characters in and every assertion below reads an empty region.
    const firstArgument = bracketed(call, "{", call.indexOf("("));
    expect(firstArgument, "the first argument is not an object").toContain("identity");
    expect(firstArgument, "the modes travel in the request body").not.toContain("MODES");
    expect(firstArgument, "the audience is no longer the body").toContain("audienceOf(req)");
    const rest = call.slice(call.indexOf(firstArgument) + firstArgument.length);
    expect(rest, "the modes are not the second argument").toContain("DRAWABLE_HINT_MODES");
  });
});
