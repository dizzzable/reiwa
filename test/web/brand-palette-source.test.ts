import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRANDING,
  resolveBrandPaletteSource,
  resolveBrandingThemeMode,
  type Branding,
} from "../../web/src/types/branding.js";

/**
 * Who owns the brand palette.
 *
 * Fourth appearance of one defect. The panel wrote a colour to the root only,
 * `resolveBrandingThemeMode` overwrote it from the concept's brightness
 * snapshot on every read, and the operator saw their colour in the panel
 * preview and nowhere else — forever. Already fixed once for the font and the
 * corner radii ("root always wins", because neither has any per-brightness
 * meaning) and once for the card gradient (an ownership marker, because a
 * concept legitimately supplies a different gradient per brightness).
 *
 * A palette needs the second answer: a concept's whole purpose is to generate a
 * distinct palette for light and for dark, so making the root always win would
 * collapse the two into one. The question is WHOSE the palette is.
 */

const CONCEPT_LIGHT = {
  primary: "#0f766e",
  primaryFg: "#ffffff",
  bgPrimary: "#fafafa",
  bgSecondary: "#f1f5f9",
};
const CONCEPT_DARK = {
  primary: "#5eead4",
  primaryFg: "#042f2e",
  bgPrimary: "#0b0b0f",
  bgSecondary: "#15151c",
};
const OPERATOR = {
  primary: "#e11d48",
  primaryFg: "#fff1f2",
  bgPrimary: "#1c1917",
  bgSecondary: "#292524",
};

function brandingWith(overrides: Partial<Branding>): Branding {
  const variant = {
    ...CONCEPT_DARK,
    cardGradient: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)",
    cardPattern: null,
    bgEffect: "NONE",
    appBackground: "NONE",
    surfaceTheme: "dark",
  } as unknown as NonNullable<Branding["themeVariants"]>["dark"];

  return {
    ...DEFAULT_BRANDING,
    ...OPERATOR,
    // The root surfaces, tagged so the assertions can name which side won. Same
    // sentinel trick the variants use: this suite is about ownership, and a
    // real `SurfaceTheme` object would only make the winner harder to read.
    surfaceTheme: "operator",
    themeVariants: {
      light: { ...variant, ...CONCEPT_LIGHT, surfaceTheme: "light" },
      dark: variant,
    },
    ...overrides,
  } as Branding;
}

describe("brand palette source", () => {
  it("treats a legacy payload with no source as a concept", () => {
    // Installs that never touched a colour keep behaving exactly as before, so
    // the change cannot repaint anyone's cabinet on upgrade.
    expect(resolveBrandPaletteSource(undefined)).toBe("concept");
  });

  it("lets the concept supply a different palette per brightness", () => {
    // This is what concepts are FOR, and what a blanket "root always wins" fix
    // would have destroyed.
    const branding = brandingWith({ brandPaletteSource: "concept" });

    expect(resolveBrandingThemeMode(branding, "light").primary).toBe(CONCEPT_LIGHT.primary);
    expect(resolveBrandingThemeMode(branding, "dark").primary).toBe(CONCEPT_DARK.primary);
    expect(resolveBrandingThemeMode(branding, "light").bgPrimary).toBe(CONCEPT_LIGHT.bgPrimary);
    expect(resolveBrandingThemeMode(branding, "dark").bgPrimary).toBe(CONCEPT_DARK.bgPrimary);
  });

  it("serves the operator's own colour in every brightness once detached", () => {
    // The reported bug, stated exactly: the panel showed this colour and the
    // cabinet showed the preset's, in both brightnesses, on every read.
    const branding = brandingWith({ brandPaletteSource: "custom" });

    for (const mode of ["light", "dark"] as const) {
      const resolved = resolveBrandingThemeMode(branding, mode);
      expect(resolved.primary).toBe(OPERATOR.primary);
      expect(resolved.primaryFg).toBe(OPERATOR.primaryFg);
      expect(resolved.bgPrimary).toBe(OPERATOR.bgPrimary);
      expect(resolved.bgSecondary).toBe(OPERATOR.bgSecondary);
    }
  });

  it("repairs an install whose variants still hold the stale preset copy", () => {
    // Nothing migrates the snapshots written before the marker existed: they
    // still carry the concept's colours in both variants. Resolving on the read
    // side is what makes those installs correct themselves on the next load —
    // the same reason the font is resolved here rather than mirrored by a
    // fourth writer in the panel.
    const branding = brandingWith({ brandPaletteSource: "custom" });
    expect(branding.themeVariants?.dark.primary).toBe(CONCEPT_DARK.primary);

    expect(resolveBrandingThemeMode(branding, "dark").primary).toBe(OPERATOR.primary);
  });

  it("moves the four colours as one palette, never two from each side", () => {
    // Detaching only the colour that was touched would composite the operator's
    // accent onto the concept's surfaces — a palette nobody designed.
    const branding = brandingWith({ brandPaletteSource: "custom" });
    const resolved = resolveBrandingThemeMode(branding, "dark");

    expect({
      primary: resolved.primary,
      primaryFg: resolved.primaryFg,
      bgPrimary: resolved.bgPrimary,
      bgSecondary: resolved.bgSecondary,
    }).toEqual(OPERATOR);
  });

  it("takes the surfaces with the palette, because they are one contrast decision", () => {
    // THIS ASSERTION USED TO SAY THE OPPOSITE, and its reason — "light and dark
    // still differ where they genuinely must: readable text against the
    // surface" — was exactly backwards. Surfaces carry the FOREGROUND colours;
    // `bgPrimary`/`bgSecondary` carry the background behind them. Leaving the
    // two halves under different owners is what makes text unreadable, not what
    // keeps it readable:
    //
    //   operator pins a dark background  → root wins for bgSecondary
    //   user selects the light rendering → variant wins for foreground
    //   → the light concept's DARK text on the operator's DARK background
    //
    // So the marker owns the whole colour system. See `Branding.brandPaletteSource`.
    const branding = brandingWith({ brandPaletteSource: "custom" });

    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme).toBe("operator");
    expect(resolveBrandingThemeMode(branding, "dark").surfaceTheme).toBe("operator");
  });

  it("still varies the surfaces per brightness while the concept owns them", () => {
    // The half that was right, and that the fix must not cost: a concept ships
    // two renderings on purpose, and an operator who never touched a colour
    // keeps both.
    const branding = brandingWith({});

    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme).toBe("light");
    expect(resolveBrandingThemeMode(branding, "dark").surfaceTheme).toBe("dark");
  });

  it("leaves branding untouched when there are no variants at all", () => {
    const branding = { ...DEFAULT_BRANDING, ...OPERATOR, themeVariants: null } as Branding;

    expect(resolveBrandingThemeMode(branding, "dark").primary).toBe(OPERATOR.primary);
  });
});
