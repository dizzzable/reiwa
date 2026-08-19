// @vitest-environment jsdom

/**
 * `resolveItemRadiusPx` and the `--radius` the document actually carries must
 * be the same number.
 *
 * The entry tile's corners were `rounded-3xl`, i.e. `calc(var(--radius) * 2.2)`
 * — so they followed the operator's theme. Reproducing that from a component
 * means reading the same source, and a second copy of `applyBrandingToDocument`'s
 * two branches is precisely how the tile would quietly stop agreeing with every
 * other rounded surface in the cabinet. This is the seam between them, and it
 * is a seam nothing else looks at: the two halves are each obviously correct
 * and would stay green while disagreeing.
 */

import { afterEach, describe, expect, it } from "vitest";

import { applyBrandingToDocument, resolveItemRadiusPx } from "../src/lib/branding-document";
import { DEFAULT_BRANDING, type Branding } from "../src/types/branding";

/** The value the document ends up with, in px, however it was spelled. */
function documentRadiusPx(branding: Branding): number {
  applyBrandingToDocument(branding);
  const raw = document.documentElement.style.getPropertyValue("--radius").trim();
  const rem = /^([\d.]+)rem$/.exec(raw);
  if (rem) return Number(rem[1]) * 16;
  const px = /^([\d.]+)px$/.exec(raw);
  expect(px, `--radius is neither rem nor px: ${raw}`).not.toBeNull();
  return Number(px![1]);
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("resolveItemRadiusPx", () => {
  it("agrees with the document for an operator-set corner radius", () => {
    for (const itemPx of [0, 8, 14, 32]) {
      const branding: Branding = {
        ...DEFAULT_BRANDING,
        cornerRadii: { cardPx: 24, itemPx, pillPx: 9999 },
      };
      expect(resolveItemRadiusPx(branding)).toBe(documentRadiusPx(branding));
    }
  });

  it("clamps out-of-range values exactly where the document clamps them", () => {
    for (const [itemPx, expected] of [
      [-40, 0],
      [999, 32],
    ] as const) {
      const branding: Branding = {
        ...DEFAULT_BRANDING,
        cornerRadii: { cardPx: 24, itemPx, pillPx: 9999 },
      };
      expect(resolveItemRadiusPx(branding)).toBe(expected);
      expect(documentRadiusPx(branding)).toBe(expected);
    }
  });

  it("agrees with the document for every legacy radius class", () => {
    // Snapshots written before `cornerRadii` existed carry only the class, and
    // the document resolves those to rem. The tile needs the same number in px.
    for (const borderRadius of [
      "rounded-none",
      "rounded-lg",
      "rounded-xl",
      "rounded-2xl",
      "rounded-3xl",
      "rounded-full",
    ]) {
      const branding = {
        ...DEFAULT_BRANDING,
        borderRadius,
        cornerRadii: undefined,
      } as unknown as Branding;
      expect(resolveItemRadiusPx(branding), borderRadius).toBe(documentRadiusPx(branding));
    }
  });

  it("falls back the same way the document does for an unknown class", () => {
    const branding = {
      ...DEFAULT_BRANDING,
      borderRadius: "rounded-from-a-future-panel",
      cornerRadii: undefined,
    } as unknown as Branding;
    // `rounded-2xl`'s item radius, 0.875rem.
    expect(resolveItemRadiusPx(branding)).toBe(14);
    expect(documentRadiusPx(branding)).toBe(14);
  });
});
