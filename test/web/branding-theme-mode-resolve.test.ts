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

/**
 * The concept's own site background, complete rather than borrowed.
 *
 * `Branding.appBackground` is optional (older snapshots predate the field) while
 * a variant's is required — which is why this used to be written as
 * `DEFAULT_BRANDING.appBackground as AppBackground`. That produced a snapshot
 * holding the ROOT's background, and the assertion "the variant's background
 * arrived" then passed whichever side had actually won. See the fixture note
 * below.
 */
const PRESET_APP_BACKGROUND: AppBackground = {
  kind: "effect",
  effect: "waves",
  props: { speed: 2 },
  opacity: 0.7,
  gradient: "linear-gradient(135deg, #000000 0%, #111111 100%)",
  texture: {
    pattern: "grid",
    color: "#334155",
    background: "#000000",
    scale: 32,
    opacity: 0.3,
  },
};

/**
 * The preset's snapshot: deliberately different from the root on every field.
 *
 * Deliberately, and now actually. Six fields used to be spelled
 * `DEFAULT_BRANDING.<the same field>` or its default value — `bgEffect`,
 * `appBackground`, `cardEffect`, `cardEffectProps`, `cardEffectsByIndex` and
 * `cardPattern` — so the snapshot AGREED with the root about them. A test
 * asserting "the resolved value is the variant's" then passed no matter which
 * side won, which is the one thing this file exists to tell apart.
 *
 * `appBackground` and `bgEffect` are the two fields in the whole resolver where
 * the SNAPSHOT wins, so between them they were the only rule that could be
 * checked nowhere else, and it was checked nowhere. The last test in this file
 * keeps the comment above honest from now on.
 */
const PRESET_VARIANT: BrandingThemeVariant = {
  primary: "#112233",
  primaryFg: "#ffffff",
  bgPrimary: "#000000",
  bgSecondary: "#101010",
  cardGradient: "linear-gradient(90deg, #000 0%, #111 100%)",
  cardPattern: "radial-gradient(#ffffff18 1px, transparent 1px)",
  cardEffect: "threads",
  cardEffectProps: { amplitude: 3 },
  cardEffectOpacity: 0.5,
  cardEffectsByIndex: [
    {
      mode: "override",
      cardEffect: "NONE",
      cardEffectProps: {},
      cardEffectOpacity: 1,
    },
  ],
  bgEffect: "AURORA",
  appBackground: PRESET_APP_BACKGROUND,
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
    const root = brandingWithVariant();
    const resolved = resolveBrandingThemeMode(root, "dark");

    expect(resolved.primary).toBe(PRESET_VARIANT.primary);
    expect(resolved.bgPrimary).toBe(PRESET_VARIANT.bgPrimary);
    expect(resolved.bgSecondary).toBe(PRESET_VARIANT.bgSecondary);
    expect(resolved.surfaceTheme?.foreground).toBe("#010101");
    // Named against the root as well, because "the variant's value arrived" is
    // not an assertion at all while the two sides hold the same value.
    expect(resolved.primary).not.toBe(root.primary);
    expect(resolved.surfaceTheme).not.toEqual(root.surfaceTheme);
  });

  it("takes the site background and the background effect from the variant", () => {
    /*
     * The two fields the SNAPSHOT owns — the only two in this resolver, and the
     * two the fixture used to copy from the root, so nothing here was being
     * checked at all.
     *
     * They are per-brightness with no ownership marker of their own, and that
     * is deliberate rather than an omission: the panel has no control for
     * `bgEffect` (only a preset writes it), and a direct `appBackground` edit
     * is mirrored into BOTH snapshots as the operator makes it. So the variant
     * already holds the operator's own background whenever they set one, and
     * the concept's per-brightness backgrounds apply while they have not.
     */
    const root = brandingWithVariant();
    const resolved = resolveBrandingThemeMode(root, "dark");

    expect(resolved.bgEffect).toBe(PRESET_VARIANT.bgEffect);
    expect(resolved.bgEffect).not.toBe(root.bgEffect);
    expect(resolved.appBackground).toEqual(PRESET_APP_BACKGROUND);
    expect(resolved.appBackground).not.toEqual(root.appBackground);
  });

  it("gives each brightness its own background rather than one for both", () => {
    // The sharper statement: this is what "per-brightness" means, and what a
    // root-wins rule here would silently flatten — one background for both
    // renderings, which is the defect this resolver keeps being fixed for, in
    // the opposite direction.
    const light: BrandingThemeVariant = {
      ...PRESET_VARIANT,
      bgEffect: "MESH",
      appBackground: {
        ...PRESET_APP_BACKGROUND,
        kind: "gradient",
        gradient: "linear-gradient(180deg, #ffffff 0%, #e2e8f0 100%)",
      },
    };
    const branding = brandingWithVariant({
      themeVariants: { light, dark: PRESET_VARIANT },
    });

    expect(resolveBrandingThemeMode(branding, "light").bgEffect).toBe("MESH");
    expect(resolveBrandingThemeMode(branding, "dark").bgEffect).toBe("AURORA");
    expect(resolveBrandingThemeMode(branding, "light").appBackground).toEqual(
      light.appBackground,
    );
    expect(resolveBrandingThemeMode(branding, "dark").appBackground).toEqual(
      PRESET_APP_BACKGROUND,
    );
  });

  it("leaves the card-effect layer alone, in every brightness", () => {
    // Stated in the resolver and pinned nowhere until now: card effects are an
    // operator-controlled layer, not a brightness token. The snapshot carries a
    // complete copy of all four fields — a different effect, different props, a
    // different opacity and a slot that switches the first card off — and the
    // resolver may read none of them.
    const root = brandingWithVariant({
      cardEffect: "aurora",
      cardEffectProps: { colorStops: ["#111111", "#222222", "#333333"] },
      cardEffectOpacity: 1,
      cardEffectsByIndex: [{ mode: "inherit" }],
    });

    for (const mode of ["light", "dark"] as const) {
      const resolved = resolveBrandingThemeMode(root, mode);

      expect(resolved.cardEffect).toBe("aurora");
      expect(resolved.cardEffectProps).toEqual(root.cardEffectProps);
      expect(resolved.cardEffectOpacity).toBe(1);
      expect(resolved.cardEffectsByIndex).toEqual([{ mode: "inherit" }]);
    }
  });

  it("carries the concept's card pattern with its gradient", () => {
    // Both belong to whoever owns the gradient, and this branding never
    // detached it. The root's pattern is `null`, so a fixture that also left
    // the variant's `null` could not tell the two apart.
    const root = brandingWithVariant();
    const resolved = resolveBrandingThemeMode(root, "dark");

    expect(resolved.cardGradient).toBe(PRESET_VARIANT.cardGradient);
    expect(resolved.cardPattern).toBe(PRESET_VARIANT.cardPattern);
    expect(resolved.cardPattern).not.toBe(root.cardPattern);
  });

  it("changes nothing at all when the snapshot predates variants", () => {
    const legacy = { ...DEFAULT_BRANDING, themeVariants: null } as Branding;

    expect(resolveBrandingThemeMode(legacy, "dark")).toBe(legacy);
  });

  it("is built on a snapshot that differs from the root on every field", () => {
    /*
     * The fixture's own guard, and the reason it exists: a field where the two
     * sides happen to agree makes every assertion about it pass whichever side
     * wins. Six fields had drifted into agreement — including both fields the
     * snapshot owns, which left the one rule only this file could check
     * unchecked.
     *
     * This is a property of the FIXTURE, so it belongs here rather than in any
     * assertion about the resolver.
     */
    const root = brandingWithVariant() as unknown as Record<string, unknown>;

    for (const [field, value] of Object.entries(PRESET_VARIANT)) {
      expect(
        { field, value },
        `PRESET_VARIANT.${field} equals the root's value, so no assertion about it can name a winner`,
      ).not.toEqual({ field, value: root[field] });
    }
  });
});
