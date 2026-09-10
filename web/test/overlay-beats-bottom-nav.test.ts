import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A MODAL HAS TO PAINT ABOVE THE FLOATING NAVIGATION.
 *
 * The shell puts the navigation pill in a `z-20` div that is a SIBLING of
 * `<main>`. So the moment `<main>` carries a z-index of its own it becomes a
 * stacking context, and every z-index a route writes is scoped inside it: a
 * modal at `z-50` inside `<main>` competes as `<main>`'s own z-index against
 * the navigation's `z-20`, and loses whatever number it picked.
 *
 * That is not a theory. Five hand-rolled overlays were caught by it — the
 * connect screen's QR sheet, the servers sheet, both wheel sheets and the media
 * viewer — and the symptom is the pill drawn lit and clickable across the
 * scrim, on top of the sheet's own buttons. It was reported on the QR sheet.
 *
 * jsdom computes no layout and paints nothing, so no test here can observe
 * z-order. What it CAN pin is the structural property that decides it, and this
 * is that property: the navigation's context must stay above `<main>`, and
 * `<main>` must not open one of its own.
 */

const root = resolve(__dirname, "..");
const shell = readFileSync(resolve(root, "src/components/layout/stealth-layout.tsx"), "utf8");
const css = readFileSync(resolve(root, "src/index.css"), "utf8");

/** Every `<main>` in the shell, with its className. */
function mainClassNames(): string[] {
  return Array.from(shell.matchAll(/<main\s*\n\s*className="([^"]+)"/g), (match) => match[1]);
}

describe("the shell's stacking", () => {
  it("has the two mains this file is about", () => {
    // Anti-emptiness anchor: a regex that stopped matching would make the case
    // below pass by checking nothing at all, which is the exact shape of the
    // green-but-blind test this repository keeps finding.
    expect(mainClassNames()).toHaveLength(2);
  });

  it("gives <main> no z-index, so a route overlay can outrank the navigation", () => {
    for (const className of mainClassNames()) {
      expect(className, "<main> is a stacking context again").not.toMatch(/(^|\s)z-/);
    }
  });

  it("keeps <main> relative, which the rail and the route grounds need", () => {
    // The other half. Dropping `relative` along with the z-index would fix the
    // stacking by breaking `PageRail`, which is positioned against it.
    for (const className of mainClassNames()) {
      expect(className).toMatch(/(^|\s)relative(\s|$)/);
    }
  });

  it("keeps the navigation above ordinary page content", () => {
    // The pill must still float over what a route draws — the fix is that a
    // MODAL outranks it, not that the navigation stops outranking content.
    expect(shell).toMatch(/bottom-nav-floating z-20/);
  });

  it("does not let the navigation's own wrapper trap it", () => {
    // `.bottom-nav-floating` is `position: absolute`; a transform, filter or
    // containment on it would make it a containing block and change what the
    // z-20 means relative to everything else.
    const rule = /\.bottom-nav-floating \{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(rule.length, "the floating navigation rule is gone").toBeGreaterThan(0);
    expect(rule).not.toMatch(/transform|filter|contain|perspective|will-change/);
  });
});

describe("the connect screen's QR sheet", () => {
  const dialog = readFileSync(
    resolve(root, "src/features/connect/connect-link-dialog.tsx"),
    "utf8",
  );

  it("portals out of the page as well", () => {
    // Belt and braces, and the braces are the point: the shell fix above is
    // what un-traps the other four overlays, and this one additionally leaves
    // the route's subtree entirely. A route that ever wraps its content in a
    // transformed element — a card effect, an animated container — would make
    // that element a containing block for `position: fixed`, and a non-portalled
    // overlay would then size itself to the PAGE rather than the viewport and
    // hang off the bottom of it. Portalled, that cannot happen.
    expect(dialog).toContain("createPortal(");
    expect(dialog).toContain("document.body");
  });

  it("carries the concept's tokens onto the overlay it portals", () => {
    // The reason it was not portalled before. Custom properties inherit down
    // the DOM, so a bare portal opens wearing the cabinet's palette on a screen
    // wearing a concept — the defect the native platform list had, in a bigger
    // box. `connect-page-composition` proves the tokens actually arrive.
    expect(dialog).toMatch(/style=\{themeStyle\}/);
  });

  it("centres the sheet at every width", () => {
    // It was `items-end` below `sm` — a bottom sheet, but a floating one with a
    // gutter rather than a flush edge, which parked it directly under the
    // navigation pill and hid its own copy button behind it.
    expect(dialog).toMatch(/fixed inset-0[^"]*items-center/);
    // The className itself, not the file: the comment above it names `items-end`
    // as what this replaced, and a scan of the whole source would read that
    // explanation as the defect.
    const overlay = /className="(fixed inset-0[^"]*)"/.exec(dialog)?.[1] ?? '';
    expect(overlay).not.toMatch(/items-end/);
  });
});
