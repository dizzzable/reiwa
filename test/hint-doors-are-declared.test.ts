import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE DOORS THIS CABINET CLAIMS, CHECKED AGAINST THE DOORS IT OPENS.
 *
 * A door is a symbolic pop-up button target: `@connect` means «Подключить»
 * exactly as the dashboard means it, through the operator's switch between the
 * cabinet's connect screen and the external page. An older cabinet would
 * navigate to `@connect` as a path and land on the catch-all page, so the panel
 * holds a door back from every cabinet that has not declared it — which makes
 * the declaration load-bearing in both directions:
 *
 *   TOO NARROW — a door the cabinet opens is not declared, so the panel never
 *   sends a single pop-up with it. «Не получилось подключиться?» simply never
 *   arrives, and nothing anywhere says why.
 *
 *   TOO WIDE — a door is declared that the cabinet does not open. The panel
 *   sends it, `hasHintCta` draws no button, and the customer gets a pop-up
 *   whose one action is missing.
 *
 * Three lists in two build trees that nothing else compares: what the BFF
 * declares (`DRAWABLE_HINT_DOORS`), what the hint code lists (`HINT_DOORS`,
 * which decides whether a button is drawn) and what it actually opens (the
 * `case` labels of `openHintDoor`). A source scan, for the reason
 * `hint-modes-are-declared.test.ts` gives: the property worth pinning is that
 * the lists agree, and that is legible in the text.
 */

const root = resolve(__dirname, "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

const ROUTE = "src/api/routes/user-hints.ts";
const HINT_CTA = "web/src/features/hints/hint-cta.ts";

/** Door names in a stretch of source: `"@name"` string literals. */
function doorsIn(text: string): string[] {
  return Array.from(text.matchAll(/["'](@[a-z][a-z0-9-]*)["']/g), (match) => match[1] as string);
}

/**
 * The text from `marker` to the bracket that closes the one it ends with —
 * brace-matched, for the reason the modes test documents: a naive cut stops
 * at the first closing bracket of a nested type and reads a region that cannot
 * contain what is being looked for.
 */
function bracketed(source: string, marker: string, from = 0): string {
  const start = source.indexOf(marker, from);
  if (start < 0) return "";
  const open = marker[marker.length - 1];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
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

/**
 * The BODY of the function `signature` opens — from the brace after its
 * parameter list to the brace that closes it. The parameter list is matched
 * first, so a brace inside it cannot be taken for the body's.
 */
function functionBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  if (at < 0) return "";
  const parameters = bracketed(source, signature, at);
  return bracketed(source, "{", at + parameters.length);
}

/** What the BFF tells the panel. */
function declaredDoors(): string[] {
  const block = bracketed(read(ROUTE), "const DRAWABLE_HINT_DOORS = [");
  expect(block, "DRAWABLE_HINT_DOORS is gone from the hints route").not.toBe("");
  return doorsIn(block);
}

/** What `hasHintCta` draws a button for. */
function listedDoors(): string[] {
  const block = bracketed(read(HINT_CTA), "export const HINT_DOORS = [");
  expect(block, "HINT_DOORS is gone from hint-cta.ts").not.toBe("");
  return doorsIn(block);
}

/** What `runHintCta` actually opens: the case labels of `openHintDoor`. */
function handledDoors(): string[] {
  const body = functionBody(read(HINT_CTA), "function openHintDoor(");
  expect(body, "openHintDoor is gone from hint-cta.ts").toContain("switch");
  return Array.from(body.matchAll(/case\s+["'](@[a-z][a-z0-9-]*)["']\s*:/g), (match) => match[1] as string);
}

const sorted = (list: readonly string[]): string[] => [...list].sort();

describe("the doors this cabinet declares to the panel", () => {
  it("were found in all three places at all", () => {
    // Anti-emptiness: three empty lists agree with one another, and that
    // agreement would be this file passing while watching nothing.
    expect(declaredDoors().length, declaredDoors().join(", ")).toBeGreaterThanOrEqual(1);
    expect(listedDoors().length, listedDoors().join(", ")).toBeGreaterThanOrEqual(1);
    expect(handledDoors().length, handledDoors().join(", ")).toBeGreaterThanOrEqual(1);
  });

  it("are exactly the ones the hint code opens", () => {
    expect(sorted(declaredDoors()), "the BFF's claim and openHintDoor's cases have drifted apart").toEqual(
      sorted(handledDoors()),
    );
  });

  it("are exactly the ones it draws a button for", () => {
    expect(sorted(listedDoors()), "HINT_DOORS and openHintDoor's cases have drifted apart").toEqual(
      sorted(handledDoors()),
    );
  });

  it("include @connect, the door the connect-help pop-up is written with", () => {
    expect(declaredDoors()).toContain("@connect");
  });

  it("decide whether a button is drawn — the list is not decoration", () => {
    const body = functionBody(read(HINT_CTA), "export function hasHintCta(");
    expect(body, "the slice missed hasHintCta's body").toContain("ctaLabel");
    expect(body, "hasHintCta no longer consults HINT_DOORS").toContain("HINT_DOORS");
  });

  it("reach the panel on the ask, as the THIRD argument — a header, never the body", () => {
    const source = read(ROUTE);
    expect(source, "the doors are not sent at all").toContain("[...DRAWABLE_HINT_DOORS]");

    const call = bracketed(source, "adminClient.userHints.next(");
    expect(call, "the ask is gone").not.toBe("");
    const firstArgument = bracketed(call, "{", call.indexOf("("));
    expect(firstArgument, "the audience is no longer the body").toContain("audienceOf(req)");
    expect(firstArgument, "the doors travel in the request body").not.toContain("DOORS");
    const rest = call.slice(call.indexOf(firstArgument) + firstArgument.length);
    const modesAt = rest.indexOf("DRAWABLE_HINT_MODES");
    const doorsAt = rest.indexOf("DRAWABLE_HINT_DOORS");
    expect(modesAt, "the modes left the call").toBeGreaterThan(-1);
    expect(doorsAt, "the doors are not an argument of the call").toBeGreaterThan(modesAt);

    // And the audience object — literally what becomes the request body.
    const audienceAt = source.indexOf("function audienceOf(");
    const audience = bracketed(source, "return {", audienceAt);
    expect(audience, "the slice missed the returned object").toContain("surface");
    expect(audience, "the doors are in the request body").not.toContain("doors");
  });
});
