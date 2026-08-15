import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRANDING,
  resolveBrandingThemeMode,
  type AppBackground,
  type Branding,
} from "../../web/src/types/branding.js";

/**
 * Who owns the surface theme — and why it is not a question of its own.
 *
 * FIFTH appearance of one defect: an operator edit lands on the branding root,
 * `resolveBrandingThemeMode` overwrites it from the concept's brightness
 * snapshot on every read, and the change shows in the panel preview and nowhere
 * else. Fixed before for the font and the corner radii ("root always wins", as
 * neither has any per-brightness meaning), for the card gradient and for the
 * brand palette (an ownership marker, as a concept legitimately ships two).
 *
 * `surfaceTheme` was deliberately left out of the palette fix, on an argument
 * that is genuinely true: text and glass colours are the one thing that must
 * differ between a light and a dark rendering. What that argument missed is
 * that it stopped being sufficient the moment the palette above could detach.
 * `surfaceTheme` holds the FOREGROUND colours and `bgPrimary`/`bgSecondary` the
 * background behind them — two halves of ONE contrast decision. Split their
 * ownership and a detached palette composes them from two different designs:
 *
 *   operator pins a dark background  → root wins for bgSecondary
 *   user selects the light rendering → variant wins for foreground
 *   → the light concept's DARK text on the operator's DARK background
 *
 * Unreadable, and it needed no exotic input — it is what every install with a
 * detached palette produced between the fourth fix and this one. A narrower
 * rule for surfaces (opacities only, or detaching only under a fixed brightness
 * policy) would have preserved that state exactly, because the disagreement is
 * BETWEEN the two owners rather than inside either. So there is one marker for
 * the whole colour system, and the halves can never disagree about whose it is.
 */

/** Backgrounds, owned by `brandPaletteSource`. */
const CONCEPT_LIGHT_BG = { bgPrimary: "#fafafa", bgSecondary: "#f1f5f9" };
const CONCEPT_DARK_BG = { bgPrimary: "#0b0b0f", bgSecondary: "#15151c" };
const OPERATOR_BG = { bgPrimary: "#1c1917", bgSecondary: "#292524" };

/**
 * Foregrounds, historically owned by the variant. Only `foreground` and one
 * opacity carry a value here: this suite asks which SIDE won, and a full
 * `SurfaceTheme` per fixture would bury that under ten fields that never differ.
 */
const CONCEPT_LIGHT_SURFACE = { foreground: "#0a0a0a", glassBlurPx: 8 };
const CONCEPT_DARK_SURFACE = { foreground: "#fafafa", glassBlurPx: 16 };
const OPERATOR_SURFACE = { foreground: "#f5f5f4", glassBlurPx: 24 };

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
  gradient: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)",
  texture: {
    pattern: "dots",
    color: "#5eead4",
    background: "#0b0b0f",
    scale: 24,
    opacity: 0.15,
  },
};

function brandingWith(overrides: Partial<Branding>): Branding {
  const variant = {
    ...CONCEPT_DARK_BG,
    primary: "#5eead4",
    primaryFg: "#042f2e",
    cardGradient: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)",
    cardPattern: null,
    bgEffect: "NONE",
    appBackground: CONCEPT_APP_BACKGROUND,
    surfaceTheme: CONCEPT_DARK_SURFACE,
  } as unknown as NonNullable<Branding["themeVariants"]>["dark"];

  return {
    ...DEFAULT_BRANDING,
    ...OPERATOR_BG,
    surfaceTheme: OPERATOR_SURFACE,
    themeVariants: {
      light: { ...variant, ...CONCEPT_LIGHT_BG, surfaceTheme: CONCEPT_LIGHT_SURFACE },
      dark: variant,
    },
    ...overrides,
  } as unknown as Branding;
}

describe("surface theme ownership", () => {
  it("keeps the concept's two renderings while the concept owns the colours", () => {
    // The property the previous argument was protecting, and the one this fix
    // must not cost. An operator who never hand-picked a colour keeps a light
    // rendering and a dark one that genuinely differ.
    const branding = brandingWith({});

    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme).toEqual(
      CONCEPT_LIGHT_SURFACE,
    );
    expect(resolveBrandingThemeMode(branding, "dark").surfaceTheme).toEqual(
      CONCEPT_DARK_SURFACE,
    );
  });

  it("serves the operator's surfaces in both renderings once the palette is theirs", () => {
    const branding = brandingWith({ brandPaletteSource: "custom" });

    for (const mode of ["light", "dark"] as const) {
      expect(resolveBrandingThemeMode(branding, mode).surfaceTheme).toEqual(
        OPERATOR_SURFACE,
      );
    }
  });

  it("NEVER composes a background and a foreground from different owners", () => {
    // The regression this file exists for, stated as the invariant rather than
    // as a value: whatever else changes, the background and the text on it must
    // come from the SAME side. A future edit that gives surfaces their own
    // marker will pass every other test here and fail this one.
    for (const source of ["concept", "custom"] as const) {
      const branding = brandingWith({ brandPaletteSource: source });

      for (const mode of ["light", "dark"] as const) {
        const resolved = resolveBrandingThemeMode(branding, mode);
        // Asserted, not asserted-away with `!`. `Branding.surfaceTheme` is
        // optional for legacy payloads, so "there are surfaces at all" is a
        // real question — and answering it wrong is how the resolver briefly
        // came to return `undefined` on the detached branch.
        expect(resolved.surfaceTheme, `${source}/${mode}: no surfaces resolved`).toBeDefined();
        const backgroundIsOperators = resolved.bgSecondary === OPERATOR_BG.bgSecondary;
        const foregroundIsOperators =
          resolved.surfaceTheme?.foreground === OPERATOR_SURFACE.foreground;

        expect(
          foregroundIsOperators,
          `${source}/${mode}: background and foreground came from different owners — ` +
            `bgSecondary=${resolved.bgSecondary}, foreground=${resolved.surfaceTheme?.foreground}`,
        ).toBe(backgroundIsOperators);
      }
    }
  });

  it("repairs an install whose variants still hold the concept's surfaces", () => {
    // Fixed on the READING side on purpose, exactly as the font was: the stale
    // copy may already sit in every deployed install's variants, and a fix that
    // needed those rewritten would need a migration. This asserts the variants
    // are untouched and the operator is served anyway.
    const branding = brandingWith({ brandPaletteSource: "custom" });

    expect(branding.themeVariants?.light.surfaceTheme).toEqual(CONCEPT_LIGHT_SURFACE);
    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme).toEqual(
      OPERATOR_SURFACE,
    );
  });

  it("treats a legacy payload with no marker as the concept's", () => {
    // Upgrade safety: installs that never touched a colour must not have their
    // cabinet repainted by this change.
    const branding = brandingWith({ brandPaletteSource: undefined });

    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme).toEqual(
      CONCEPT_LIGHT_SURFACE,
    );
  });

  it("moves the opacities and the blur with the colours, not separately", () => {
    // They live in the same object, and a half-owned `surfaceTheme` is the same
    // split this fix removes. Named explicitly because "detach only the
    // opacities" was a considered option.
    const branding = brandingWith({ brandPaletteSource: "custom" });

    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme?.glassBlurPx).toBe(
      OPERATOR_SURFACE.glassBlurPx,
    );
  });

  it("falls back to the concept when the operator has no surfaces at all", () => {
    // `Branding.surfaceTheme` is optional so a payload predating the field is
    // handled gracefully. Detaching the palette must not turn that absence into
    // a resolved `undefined` — the variant's copy is required and is the only
    // surfaces that exist for such an install. Caught by the type-checker after
    // this file's own project (`web/tsconfig.test.json`, the one that owns
    // `../test/web`) was run for the first time.
    const branding = brandingWith({ brandPaletteSource: "custom", surfaceTheme: undefined });

    expect(resolveBrandingThemeMode(branding, "light").surfaceTheme).toEqual(
      CONCEPT_LIGHT_SURFACE,
    );
  });

  it("leaves branding untouched when there are no variants at all", () => {
    const branding = {
      ...DEFAULT_BRANDING,
      surfaceTheme: OPERATOR_SURFACE,
      themeVariants: null,
    } as unknown as Branding;

    expect(resolveBrandingThemeMode(branding, "dark").surfaceTheme).toEqual(
      OPERATOR_SURFACE,
    );
  });
});
