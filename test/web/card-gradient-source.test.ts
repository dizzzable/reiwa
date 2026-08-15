import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRANDING,
  resolveBrandingThemeMode,
  resolveCardGradientSource,
  type AppBackground,
  type Branding,
} from "../../web/src/types/branding.js";

/**
 * Who owns the card gradient.
 *
 * One field used to serve two meanings that cannot be told apart — "the
 * concept's palette" and "the gradient I wrote myself" — and the variant
 * always won. An operator saved a gradient in the panel, the cabinet went on
 * drawing the concept's, on every read, forever. It is the same defect already
 * fixed for the font and the corner radii, but it could not be fixed the same
 * way: a font has no per-brightness meaning, while a card gradient has one
 * exactly when a concept supplies it, and making the root always win would
 * have destroyed what concepts are for.
 *
 * So the resolution is to know WHOSE the gradient is, not to pick a side.
 */

const CONCEPT_LIGHT = "linear-gradient(135deg, #fef3c7 0%, #f59e0b 100%)";
const CONCEPT_DARK = "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)";
const OPERATOR = "linear-gradient(135deg, #262626 0%, #525252 100%)";

/**
 * The concept's site background. Not this suite's subject, and not a sentinel
 * either — a variant carries a complete `AppBackground` OBJECT, and this
 * fixture used to put the string `"NONE"` in its place, which the surrounding
 * `as unknown as` cast swallowed silently.
 */
const CONCEPT_APP_BACKGROUND: AppBackground = {
  kind: "gradient",
  effect: "NONE",
  props: {},
  opacity: 1,
  gradient: CONCEPT_DARK,
  texture: {
    pattern: "dots",
    color: "#7c3aed",
    background: "#0b0b0f",
    scale: 24,
    opacity: 0.15,
  },
};

function brandingWith(overrides: Partial<Branding>): Branding {
  const variant = {
    primary: "#7c3aed",
    primaryFg: "#ffffff",
    bgPrimary: "#0b0b0f",
    bgSecondary: "#15151c",
    cardGradient: CONCEPT_DARK,
    cardPattern: "linear-gradient(#ffffff20 1px, transparent 1px)",
    bgEffect: "NONE",
    appBackground: CONCEPT_APP_BACKGROUND,
    surfaceTheme: "dark",
  } as unknown as NonNullable<Branding["themeVariants"]>["dark"];

  return {
    ...DEFAULT_BRANDING,
    cardGradient: OPERATOR,
    cardPattern: null,
    themeVariants: {
      light: { ...variant, cardGradient: CONCEPT_LIGHT, surfaceTheme: "light" },
      dark: variant,
    },
    ...overrides,
  } as Branding;
}

describe("card gradient source", () => {
  it("treats a legacy payload with no source as a concept", () => {
    // Installs that never touched the control keep behaving exactly as before,
    // so the change cannot alter anyone's card on upgrade.
    expect(resolveCardGradientSource(undefined)).toBe("concept");
  });

  it("lets the concept supply a different gradient per brightness", () => {
    // This is what concepts are FOR, and what a blanket "root always wins"
    // fix would have destroyed.
    const branding = brandingWith({ cardGradientSource: "concept" });

    expect(resolveBrandingThemeMode(branding, "light").cardGradient).toBe(CONCEPT_LIGHT);
    expect(resolveBrandingThemeMode(branding, "dark").cardGradient).toBe(CONCEPT_DARK);
  });

  it("serves the operator's own gradient in every brightness once detached", () => {
    // The reported bug: the panel showed this gradient, the cabinet did not.
    const branding = brandingWith({ cardGradientSource: "custom" });

    expect(resolveBrandingThemeMode(branding, "light").cardGradient).toBe(OPERATOR);
    expect(resolveBrandingThemeMode(branding, "dark").cardGradient).toBe(OPERATOR);
  });

  it("carries the pattern with the gradient rather than splitting them", () => {
    // The pattern is the texture ON the gradient. Taking one from the operator
    // and the other from the concept composites two unrelated designs.
    const branding = brandingWith({
      cardGradientSource: "custom",
      cardPattern: "radial-gradient(#ffffff10 1px, transparent 1px)",
    });

    expect(resolveBrandingThemeMode(branding, "dark").cardPattern).toBe(
      "radial-gradient(#ffffff10 1px, transparent 1px)",
    );
  });

  it("still takes surfaces and text colours from the variant when detached", () => {
    // Detaching owns the gradient, nothing else. Light and dark still differ in the
    // one place they genuinely must: readable text against the surface.
    const branding = brandingWith({ cardGradientSource: "custom" });

    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme).toBe("light");
    expect(resolveBrandingThemeMode(branding, "dark").surfaceTheme).toBe("dark");
  });

  it("leaves branding untouched when there are no variants at all", () => {
    const branding = { ...DEFAULT_BRANDING, cardGradient: OPERATOR, themeVariants: null } as Branding;

    expect(resolveBrandingThemeMode(branding, "dark").cardGradient).toBe(OPERATOR);
  });
});
