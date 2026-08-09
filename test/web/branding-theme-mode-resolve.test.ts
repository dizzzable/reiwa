/**
 * `resolveBrandingThemeMode` — what a brightness switch may and may not change.
 *
 * The theme variants are a snapshot of the concept preset, written once when
 * the operator applies it. Only three global controls are mirrored back into
 * them afterwards (card gradient, card pattern, card text). Anything else the
 * operator edits later lands on the ROOT branding — so any field this resolver
 * reads off the variant is a field whose later edits are silently discarded on
 * every read.
 *
 * That is exactly how the font selector came to do nothing: the panel writes
 * `fontFamily` to the root, this function overwrote it with the preset's
 * original, and the cabinet rendered the preset font forever. The corner radii
 * had the same defect, unreported.
 *
 * These tests are written as the two-sided rule — root wins for the operator's
 * global decisions, variant wins for what genuinely differs between a light and
 * a dark rendering — because a fix in either direction alone is wrong.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRANDING,
  DEFAULT_SURFACE_THEME,
  resolveBrandingThemeMode,
  type AppBackground,
  type Branding,
  type BrandingThemeVariant,
} from "../../web/src/types/branding.js";

/** The preset's snapshot: deliberately different from the root on every field. */
const PRESET_VARIANT: BrandingThemeVariant = {
  primary: "#112233",
  primaryFg: "#ffffff",
  bgPrimary: "#000000",
  bgSecondary: "#101010",
  cardGradient: "linear-gradient(90deg, #000 0%, #111 100%)",
  cardPattern: null,
  cardEffect: DEFAULT_BRANDING.cardEffect,
  cardEffectProps: {},
  cardEffectOpacity: 0.5,
  cardEffectsByIndex: [],
  bgEffect: DEFAULT_BRANDING.bgEffect,
  // `Branding.appBackground` / `.surfaceTheme` are optional (older snapshots
  // predate them) but a variant requires both, so take the complete defaults
  // rather than the possibly-absent fields off `DEFAULT_BRANDING`.
  appBackground: DEFAULT_BRANDING.appBackground as AppBackground,
  borderRadius: "rounded-none",
  cornerRadii: { cardPx: 0, itemPx: 0, pillPx: 0 },
  fontFamily: "Playfair Display, serif",
  surfaceTheme: { ...DEFAULT_SURFACE_THEME, foreground: "#010101" },
};

function brandingWithVariant(overrides: Partial<Branding> = {}): Branding {
  return {
    ...DEFAULT_BRANDING,
    // What the operator picked AFTER applying the preset — root only.
    fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
    borderRadius: "rounded-3xl",
    cornerRadii: { cardPx: 15, itemPx: 12, pillPx: 999 },
    themeVariants: { light: PRESET_VARIANT, dark: PRESET_VARIANT },
    ...overrides,
  } as Branding;
}

describe("resolveBrandingThemeMode", () => {
  it("keeps the operator's font — the variant must not restore the preset's", () => {
    const resolved = resolveBrandingThemeMode(brandingWithVariant(), "dark");

    expect(resolved.fontFamily).toBe(
      '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
    );
    expect(resolved.fontFamily).not.toBe(PRESET_VARIANT.fontFamily);
  });

  it("keeps the operator's corner geometry for the same reason", () => {
    const resolved = resolveBrandingThemeMode(brandingWithVariant(), "dark");

    expect(resolved.borderRadius).toBe("rounded-3xl");
    expect(resolved.cornerRadii).toEqual({ cardPx: 15, itemPx: 12, pillPx: 999 });
  });

  it("gives the same answer in both brightnesses, because neither is a brightness token", () => {
    // The sharper statement of the rule: a user toggling light/dark must not be
    // able to change the typeface or the geometry at all.
    const light = resolveBrandingThemeMode(brandingWithVariant(), "light");
    const dark = resolveBrandingThemeMode(brandingWithVariant(), "dark");

    expect(light.fontFamily).toBe(dark.fontFamily);
    expect(light.borderRadius).toBe(dark.borderRadius);
    expect(light.cornerRadii).toEqual(dark.cornerRadii);
  });

  it("still takes colours and surfaces from the variant", () => {
    // The other half of the rule. Without this a "fix" that simply stopped
    // reading the variant would pass everything above while breaking the light
    // theme entirely — light text on a light background.
    const resolved = resolveBrandingThemeMode(brandingWithVariant(), "dark");

    expect(resolved.primary).toBe(PRESET_VARIANT.primary);
    expect(resolved.bgPrimary).toBe(PRESET_VARIANT.bgPrimary);
    expect(resolved.bgSecondary).toBe(PRESET_VARIANT.bgSecondary);
    expect(resolved.surfaceTheme?.foreground).toBe("#010101");
  });

  it("changes nothing at all when the snapshot predates variants", () => {
    const legacy = { ...DEFAULT_BRANDING, themeVariants: null } as Branding;

    expect(resolveBrandingThemeMode(legacy, "dark")).toBe(legacy);
  });
});
