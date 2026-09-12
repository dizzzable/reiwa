/**
 * The rules every QR code in the cabinet is drawn by, and who may draw one.
 *
 * The defect this file exists for was not a wrong value — it was TWO wrong
 * values in one of three copies of the same options object. The referral code
 * was drawn with near-white modules on `#00000000`: an inverted code (which
 * ZXing's JS port and v2rayNG's camera path never attempt) whose background
 * became white the moment anyone saved or forwarded the image, leaving
 * near-white on white. So the strongest cases here are not any assertion about
 * a colour — they are the source scans at the end. One fails if anything but
 * the two shared modules touches the encoder, which is where a fourth copy of
 * those options would have to live. The other fails if the operator's style
 * reaches a code it must not — above all the connect code, which VPN clients'
 * in-app scanners read.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { MIN_PIXELS_PER_MODULE, QUIET_ZONE_MODULES, qrOptions, relativeLuminance } from "@/lib/qr-options";

const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** A subscription link is the longest thing the cabinet encodes. */
const LONG_LINK =
  "https://cabinet.example.com/subscription/9f2c1e7a-4d8b-4b2f-9c31-7a5e6f0b8d14?token=" +
  "aGVsbG8td29ybGQtdGhpcy1pcy1hLXJlYWxpc3RpYy1sZW5ndGgtdG9rZW4";

describe("the colours of the plain code", () => {
  // Read off the rendered SVG, not off the options object. The defect this file
  // exists for was a value that looked like a colour and rendered as nothing —
  // and every plain code in the cabinet, the connect code first, is this markup.
  it("is black modules on an opaque white field covering the whole code", async () => {
    const svg = await QRCode.toString(LONG_LINK, qrOptions());
    const side = /viewBox="0 0 (\d+) \1"/.exec(svg)?.[1];
    expect(side, "the SVG no longer declares a square viewBox").toBeDefined();

    // `qrcode` paints the light field as one path over the full viewBox, and
    // omits it ENTIRELY when the colour is transparent — which is how the
    // referral code shipped blank. Then the dark modules, as one stroked path.
    // A partial alpha is written as a `*-opacity` attribute straight after the
    // colour, so it breaks these literals as well — a translucent module colour
    // was caught exactly that way by mutation, which is why there is no
    // separate opacity check that nothing could ever reach.
    expect(svg, "the light field is not an opaque white square under the whole code").toContain(
      `<path fill="#ffffff" d="M0 0h${side}v${side}H0z"/>`,
    );
    expect(svg, "the modules are not opaque black").toContain('<path stroke="#000000" d="');
  });

  it("orders luminance the way a scanner reads it", () => {
    expect(relativeLuminance("#000000")).toBeLessThan(relativeLuminance("#ffffff"));
    expect(relativeLuminance("#fafafa")).toBeGreaterThan(relativeLuminance("#0a0a0a"));
  });
});

describe("the quiet zone", () => {
  it("measures four modules in the rendered code, not just in the options", async () => {
    // Measured, not pinned: the matrix size comes from the encoder and the
    // drawn size from the viewBox, so this fails if `margin` stops reaching
    // the renderer — which is the way this could silently regress.
    const svg = await QRCode.toString(LONG_LINK, qrOptions());
    const matrix = QRCode.create(LONG_LINK, { errorCorrectionLevel: "M" });
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);

    expect(viewBox, "the SVG no longer declares a square viewBox").not.toBeNull();
    const drawn = Number(viewBox?.[1]);
    const quietZone = (drawn - matrix.modules.size) / 2;

    expect(
      quietZone,
      `ISO/IEC 18004 §6.3.8 requires 4X on every side; this code was drawn with ${quietZone}`,
    ).toBe(QUIET_ZONE_MODULES);
  });

  it("is what the standard asks for, not merely what the library defaults to", () => {
    expect(QUIET_ZONE_MODULES).toBe(4);
  });
});

describe("pixels per module", () => {
  it("keeps the connect code above the documented floor at the size it renders", async () => {
    // ML Kit: "the smallest meaningful unit of the barcode should be at least
    // 2 pixels wide". The connect sheet draws at 208 CSS px. This is a floor,
    // not a target — the practical figure measured across decoders is nearer
    // three — so if this ever gets close, the answer is a bigger code.
    const matrix = QRCode.create(LONG_LINK, { errorCorrectionLevel: "M" });
    const across = matrix.modules.size + QUIET_ZONE_MODULES * 2;
    const perModule = 208 / across;

    expect(
      perModule,
      `the longest link renders at ${perModule.toFixed(2)} px per module at 208 px`,
    ).toBeGreaterThanOrEqual(MIN_PIXELS_PER_MODULE);
  });
});

/* ───────────────────────────── reading the sources ─────────────────────────── */

/**
 * The two files that may use the `qrcode` package at run time. Every other file
 * draws through what they export — `qrSvg`, which takes the plain path through
 * `qrOptions()` and the styled one through the matrix — so a fourth copy of the
 * options cannot exist anywhere without first touching the encoder here.
 */
const ENCODER_OWNERS: readonly string[] = ["lib/qr-options.ts", "lib/qr-style.ts"];

const LOCAL_QR = "components/ui/local-qr.tsx";
const CONNECT_SHEET = "features/connect/connect-link-dialog.tsx";
const INVITE_HERO = "features/referrals/components/invite-link-hero.tsx";
const PARTNER_ADS = "features/partner/components/partner-advertising-section.tsx";

/** Every `.ts`/`.tsx` under `web/src`, `web/src`-relative, so a new call site cannot hide. */
function sources(dir: string = WEB_SRC, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, into);
    else if (/\.tsx?$/.test(entry)) into.push(path.slice(WEB_SRC.length + 1).split(sep).join("/"));
  }
  return into;
}

function readSource(relative: string): string {
  return readFileSync(join(WEB_SRC, relative), "utf8");
}

/**
 * Parsed rather than pattern-matched. A regular expression reads a comment as
 * code, runs across statements in a file written without semicolons, and cannot
 * tell a JSX prop from the same word anywhere else. The AST sees what the
 * compiler sees.
 */
function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function parseSource(relative: string): ts.SourceFile {
  return parse(relative, readSource(relative));
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * The `qrcode` package, by any specifier that loads it. A subpath counts: the
 * package publishes no `exports` map, so `qrcode/lib/core/qrcode` is a working
 * second door to the very `create` the styled renderer is built on, and this
 * rule is about the ENCODER rather than about one string.
 */
function isQrcodeSpecifier(node: ts.Node | undefined): boolean {
  if (node === undefined || !ts.isStringLiteral(node)) return false;
  return node.text === "qrcode" || node.text.startsWith("qrcode/");
}

/** A static import that loads the package at run time — anything but a type-only one. */
function importsAtRunTime(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  // `import 'qrcode'` runs the module.
  if (clause === undefined) return true;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  // `import { type A, type B } from 'qrcode'` is erased whole.
  return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
}

/**
 * Every way a file reaches the `qrcode` encoder, as what was found — empty for
 * a file that does not:
 *
 *   - a call on `QRCode`, by ANY method. The scan this replaced listed three —
 *     `toString`, `toDataURL`, `toCanvas` — and so could not see
 *     `QRCode.create`, the call the styled renderer is built on;
 *   - loading the package under any name: a static import that is not
 *     type-only, a re-export, `import('qrcode')`, `require('qrcode')`. That is
 *     what makes the rule proof against an alias: `import { create } from
 *     'qrcode'` calls nothing on `QRCode` at all.
 *
 * A type-only import draws nothing and is not counted, and neither is a
 * comment.
 */
function encoderUse(file: ts.SourceFile): string[] {
  const found: string[] = [];
  walk(file, (node) => {
    if (ts.isImportDeclaration(node)) {
      if (isQrcodeSpecifier(node.moduleSpecifier) && importsAtRunTime(node)) found.push("imports qrcode");
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isQrcodeSpecifier(node.moduleReference.expression)
      ) {
        found.push("imports qrcode");
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && isQrcodeSpecifier(node.moduleSpecifier)) found.push("re-exports qrcode");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      if (loads && isQrcodeSpecifier(node.arguments[0])) found.push("loads qrcode");
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "QRCode"
      ) {
        found.push(`calls QRCode.${callee.name.text}`);
      }
    }
  });
  return found;
}

/** Calls to a function by its bare name — every `qrSvg(…)`, say. */
function callsTo(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(file, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node);
    }
  });
  return calls;
}

/**
 * Every `<LocalQr …>` in a file, as its props: name → the source of the value,
 * `""` for a bare boolean prop. A spread is recorded under `...`, because it
 * could carry anything — a style included.
 */
function localQrElements(file: ts.SourceFile): Array<Record<string, string>> {
  const elements: Array<Record<string, string>> = [];
  walk(file, (node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(file) === "LocalQr"
    ) {
      const props: Record<string, string> = {};
      for (const property of node.attributes.properties) {
        if (ts.isJsxAttribute(property)) {
          props[property.name.getText(file)] = property.initializer?.getText(file) ?? "";
        } else {
          props["..."] = property.getText(file);
        }
      }
      elements.push(props);
    }
  });
  return elements;
}

/**
 * The names a file binds to the operator's style, resolved AND memoised on the
 * one field it comes from:
 *
 *     const x = useMemo(() => resolveQrStyle(branding.qrStyle), [branding.qrStyle])
 *
 * Memoised because what it is handed to depends on the object — `LocalQr`'s
 * drawing effect, the invite's `handleQr` — so a style resolved during render
 * is a new object on every render, and a re-encoded code every time.
 */
function memoisedStyles(file: ts.SourceFile): string[] {
  const names: string[] = [];
  walk(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      node.initializer.getText(file).replace(/\s+/g, "") ===
        "useMemo(()=>resolveQrStyle(branding.qrStyle),[branding.qrStyle])"
    ) {
      names.push(node.name.text);
    }
  });
  return names;
}

describe("who may touch the encoder", () => {
  it("is the two shared modules, and nothing else", () => {
    // THE case this file is for. Three copies of these options drifted apart
    // and one of them shipped an unscannable code; a fourth copy must be a red
    // build, not a code review someone might skip. Every other file draws
    // through `qrSvg` — directly, or through `LocalQr`.
    const offenders = sources()
      .filter((path) => !ENCODER_OWNERS.includes(path))
      // Cheap prefilter, and a sound one: every construct `encoderUse` looks
      // for spells one of these two words out in the text.
      .filter((path) => /qrcode|QRCode/.test(readSource(path)))
      .map((path) => [path, encoderUse(parseSource(path))] as const)
      .filter(([, found]) => found.length > 0)
      .map(([path, found]) => `${path}: ${found.join(", ")}`);

    expect(
      offenders,
      "these reach the `qrcode` encoder themselves instead of going through `qrSvg`; " +
        "that is exactly how the referral code came to be white-on-transparent",
    ).toEqual([]);
  });

  it("recognises every way in — `QRCode.create` included — and not a type-only import or a comment", () => {
    // The detector itself, on inputs whose answer is known. Without this the
    // case above passes just as well for a detector that sees nothing.
    const use = (text: string): string[] => encoderUse(parse("probe.ts", text));

    expect(use("QRCode.create(text, { errorCorrectionLevel: 'H' })")).toEqual(["calls QRCode.create"]);
    expect(use("QRCode.toDataURL(text)")).toEqual(["calls QRCode.toDataURL"]);
    expect(use("import QRCode from 'qrcode'")).toEqual(["imports qrcode"]);
    expect(use("import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode'")).toEqual([
      "imports qrcode",
    ]);
    expect(use("import { create } from 'qrcode'")).toEqual(["imports qrcode"]);
    expect(use('import * as encoder from "qrcode"')).toEqual(["imports qrcode"]);
    expect(use("const encoder = await import('qrcode')")).toEqual(["loads qrcode"]);
    expect(use("const encoder = require('qrcode')")).toEqual(["loads qrcode"]);
    expect(use("export { toString } from 'qrcode'")).toEqual(["re-exports qrcode"]);

    // A subpath reaches the same encoder, and the package has no `exports` map
    // to stop it; a package that merely starts with the same letters does not.
    expect(use('import QRCode from "qrcode/lib/core/qrcode"')).toEqual(["imports qrcode"]);
    expect(use('const core = require("qrcode/lib/core/qrcode")')).toEqual(["loads qrcode"]);
    expect(use('import generate from "qrcode-generator"')).toEqual([]);

    expect(use("import type { QRCodeToStringOptions } from 'qrcode'")).toEqual([]);
    expect(use("import { type QRCodeToStringOptions } from 'qrcode'")).toEqual([]);
    expect(use("// QRCode.toString(link) is how this used to be drawn")).toEqual([]);
    expect(use("const svg = await qrSvg(link, style, 208)")).toEqual([]);
  });

  it("finds the encoder and the drawing call sites at all, so the rule cannot pass by finding nothing", () => {
    // Anti-vacuous anchor. A move of the lib files, a rename of the `qrcode`
    // import, or a parser that stopped reading would empty the scan and turn
    // the first case into a test that always passes.
    const all = sources();
    for (const owner of ENCODER_OWNERS) {
      expect(all, `${owner} is not where the allowlist says — the allowlist names nothing`).toContain(owner);
    }

    // The real renderer, read through the real detector: it imports the
    // package and calls both halves of it — `toString` for the plain path and
    // `create` for the styled one, which is the call the old scan was blind to.
    expect(encoderUse(parseSource("lib/qr-style.ts"))).toEqual(
      expect.arrayContaining(["imports qrcode", "calls QRCode.toString", "calls QRCode.create"]),
    );

    // And the codes on screen reach it through `qrSvg`.
    const drawing = all.filter(
      (path) => !ENCODER_OWNERS.includes(path) && callsTo(parseSource(path), "qrSvg").length > 0,
    );
    expect(drawing, "no file draws a QR code through `qrSvg` any more — has the API changed?").toEqual(
      expect.arrayContaining([LOCAL_QR, INVITE_HERO]),
    );
  });
});

describe("which codes the operator's style reaches", () => {
  // The owner's decision: styling applies to the referral invite and the
  // partner's advertising codes, and the connect code — the subscription link,
  // read by VPN clients' in-app scanners — always stays plain. The components
  // that draw them are proven by rendering in `qr-style-call-sites.test.tsx`;
  // these read the call sites themselves, so the decision cannot drift out of
  // a file without this file noticing.

  it("never hands the connect sheet's code a style — the subscription link stays plain", () => {
    const elements = localQrElements(parseSource(CONNECT_SHEET));
    expect(elements.length, "the connect sheet no longer renders a LocalQr — has it moved?").toBeGreaterThan(0);
    for (const props of elements) {
      expect(
        Object.keys(props),
        `the connect sheet's <LocalQr> is handed a style (${JSON.stringify(props)}); ` +
          "its code is read by the strictest scanners there are and must be plain",
      ).not.toContain("style");
      expect(
        Object.keys(props),
        `the connect sheet's <LocalQr> takes a spread (${props["..."]}), which can smuggle a style in`,
      ).not.toContain("...");
    }
  });

  it("draws the referral invite with the operator's style, resolved and memoised", () => {
    const file = parseSource(INVITE_HERO);
    const styles = memoisedStyles(file);
    expect(
      styles,
      "the invite does not resolve `branding.qrStyle` through a memoised `resolveQrStyle`",
    ).toHaveLength(1);

    const draws = callsTo(file, "qrSvg");
    expect(draws.length, "the invite no longer draws its code with `qrSvg`").toBeGreaterThan(0);
    for (const call of draws) {
      expect(
        call.arguments[1]?.getText(file),
        `the invite draws with \`${call.getText(file)}\` — not the resolved style`,
      ).toBe(styles[0]);
    }
  });

  it("draws both partner codes with the operator's style, resolved and memoised", () => {
    const file = parseSource(PARTNER_ADS);
    const styles = memoisedStyles(file);
    expect(
      styles,
      "the partner section does not resolve `branding.qrStyle` through a memoised `resolveQrStyle`",
    ).toHaveLength(1);

    const elements = localQrElements(file);
    expect(elements.length, "the partner section no longer renders its two codes").toBeGreaterThanOrEqual(2);
    for (const props of elements) {
      expect(props["style"], `a partner <LocalQr> is drawn without the resolved style: ${JSON.stringify(props)}`).toBe(
        `{${styles[0]}}`,
      );
    }
  });

  it("resolves the style in those two places and nowhere else — and LocalQr never looks it up", () => {
    const resolving = sources()
      .filter((path) => !ENCODER_OWNERS.includes(path))
      .filter((path) => readSource(path).includes("resolveQrStyle"))
      .filter((path) => callsTo(parseSource(path), "resolveQrStyle").length > 0)
      .sort();
    expect(
      resolving,
      "the operator's QR style is resolved somewhere new — every code it reaches has to be one the owner chose",
    ).toEqual([INVITE_HERO, PARTNER_ADS].sort());

    // `LocalQr` is shared with the connect sheet. If it read the branding for
    // itself, the connect code would be styled with nobody deciding it.
    const localQr = parseSource(LOCAL_QR);
    expect(callsTo(localQr, "useBranding"), "LocalQr reads the branding itself").toEqual([]);
    expect(callsTo(localQr, "resolveQrStyle"), "LocalQr resolves a style itself").toEqual([]);
  });
});
