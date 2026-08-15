import { describe, expect, it } from "vitest";

import { isPublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port.js";
import {
  DEFAULT_PUBLIC_CONFIG,
  resolveAppBackgroundKind,
} from "../../web/src/types/branding.js";

/**
 * A newer panel must not be able to freeze an older cabinet — the app
 * background edition.
 *
 * `appBackground.kind` was checked here against a hard-coded Set of the four
 * modes this build shipped. That is the same shape of mistake that already cost
 * this project two outages (`navItems`, then `cardEffect`), and it was about to
 * cost a third: rezeis-admin is gaining a `plain` mode, and every cabinet
 * released before it would have refused the whole snapshot over that one word.
 *
 * The refusal is not visible as a refusal. `isPublicConfigSnapshot` is one
 * first-rejection-wins chain over the ENTIRE public config, `fetchFreshPayload`
 * throws before it can `save`, and `src/api/routes/branding.ts` answers with the
 * previously cached snapshot instead — for good, not until a restart. The
 * cabinet's colours, logo, texts and navigation all stop tracking the panel,
 * while the panel keeps reporting that every save succeeded.
 *
 * These tests fix the shape of the escape, in both halves: unknown kinds
 * travel, and they resolve to `none` — the built-in background this deployment
 * was already drawing — where they are used.
 *
 * `NOT_A_REAL_KIND` is deliberately absurd. If a mode by that name is ever
 * added, this file does not quietly stop testing anything: the resolution
 * assertion below starts failing loudly.
 */

const NOT_A_REAL_KIND = "kindFromAFuturePanelRelease";

/**
 * The shipped default block. It is optional on `Branding` (older snapshots have
 * none), but the defaults always carry one — asserting that here keeps every
 * fixture below honest instead of quietly building on `undefined`.
 */
const DEFAULT_APP_BACKGROUND = DEFAULT_PUBLIC_CONFIG.branding.appBackground;
if (DEFAULT_APP_BACKGROUND === undefined) {
  throw new Error("DEFAULT_PUBLIC_CONFIG must ship an appBackground block");
}

function withAppBackground(overrides: Record<string, unknown>): unknown {
  return {
    ...DEFAULT_PUBLIC_CONFIG,
    branding: {
      ...DEFAULT_PUBLIC_CONFIG.branding,
      appBackground: { ...DEFAULT_APP_BACKGROUND, ...overrides },
    },
  };
}

describe("app background kind open vocabulary", () => {
  it("accepts the kind rezeis-admin is about to start sending", () => {
    // The concrete forward-compatibility case: this build predates `plain`.
    expect(isPublicConfigSnapshot(withAppBackground({ kind: "plain" }))).toBe(true);
  });

  it("accepts a kind this build has never heard of", () => {
    expect(isPublicConfigSnapshot(withAppBackground({ kind: NOT_A_REAL_KIND }))).toBe(true);
  });

  it("accepts the unknown kind inside a light/dark theme variant", () => {
    // Concepts write a full `appBackground` into each variant, so a kind the
    // panel adds arrives twice more per snapshot.
    const b = DEFAULT_PUBLIC_CONFIG.branding;
    const variant = {
      primary: b.primary,
      primaryFg: b.primaryFg,
      bgPrimary: b.bgPrimary,
      bgSecondary: b.bgSecondary,
      cardGradient: b.cardGradient,
      cardPattern: b.cardPattern,
      cardEffect: b.cardEffect,
      cardEffectProps: {},
      cardEffectOpacity: 1,
      cardEffectsByIndex: [],
      bgEffect: b.bgEffect,
      appBackground: b.appBackground,
      borderRadius: b.borderRadius,
      cornerRadii: b.cornerRadii,
      fontFamily: b.fontFamily,
      surfaceTheme: b.surfaceTheme,
    };
    const baseline = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...b,
        themeVariants: { light: variant, dark: variant },
      },
    };
    // Guards the fixture itself: an incomplete variant would make the assertion
    // below pass for the wrong reason on the very next release.
    expect(isPublicConfigSnapshot(baseline)).toBe(true);

    const config = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...b,
        themeVariants: {
          light: variant,
          dark: {
            ...variant,
            appBackground: { ...b.appBackground, kind: NOT_A_REAL_KIND },
          },
        },
      },
    };

    expect(isPublicConfigSnapshot(config)).toBe(true);
  });

  it("carries the unknown kind through verbatim rather than rewriting it", () => {
    // The cabinet stores what it was given. Coercing here would make the panel
    // and the cabinet disagree about what is configured, and a later cabinet
    // release that DOES know the kind would find it already destroyed.
    const config = withAppBackground({ kind: NOT_A_REAL_KIND });
    if (!isPublicConfigSnapshot(config)) throw new Error("fixture must be valid");

    const branding = config.branding as Record<string, Record<string, unknown>>;
    expect(branding["appBackground"]?.["kind"]).toBe(NOT_A_REAL_KIND);
  });

  it("still accepts a block with no kind at all", () => {
    // Not tolerance of the unknown — the pre-`kind` payload shape, which the
    // guard reads by inferring the kind from the effect id. It predates this
    // whole discriminator and every installation older than the field sends it.
    expect(isPublicConfigSnapshot(withAppBackground({ kind: undefined }))).toBe(true);
  });

  /**
   * Tolerance is not absence of checking. Without these the guard would be a
   * no-op that passes everything above for the wrong reason.
   */
  it.each([
    ["a null kind", null],
    ["an empty name", ""],
    ["a number", 7],
    ["an object", { kind: "gradient" }],
    ["a name longer than any real identifier", "k".repeat(65)],
  ])("still rejects %s", (_label, value) => {
    expect(isPublicConfigSnapshot(withAppBackground({ kind: value }))).toBe(false);
  });

  it("keeps the rest of the app-background block checked", () => {
    // Loosening `kind` must not have loosened its neighbours: an unusable
    // gradient or texture is corruption, not a newer panel.
    expect(
      isPublicConfigSnapshot(withAppBackground({ gradient: "url(javascript:alert(1))" })),
    ).toBe(false);
    expect(isPublicConfigSnapshot(withAppBackground({ opacity: 4 }))).toBe(false);
    expect(
      isPublicConfigSnapshot(
        withAppBackground({
          kind: "texture",
          texture: {
            ...DEFAULT_APP_BACKGROUND.texture,
            pattern: "herringbone",
          },
        }),
      ),
    ).toBe(false);
  });

  it("keeps the neighbouring closed enums closed", () => {
    const config = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: { ...DEFAULT_PUBLIC_CONFIG.branding, bgEffect: "SOMETHING_NEW" },
    };
    expect(isPublicConfigSnapshot(config)).toBe(false);
  });
});

describe("app background kind resolution", () => {
  it("resolves an unknown kind to the built-in background", () => {
    // The consuming half of the contract. `none` is not "nothing": it is
    // `<NetworkBg>`, the picture this deployment already shows. Degrading to it
    // means a panel released ahead of the cabinet looks unchanged rather than
    // blank.
    expect(resolveAppBackgroundKind(NOT_A_REAL_KIND)).toBe("none");
    expect(resolveAppBackgroundKind(undefined)).toBe("none");
    expect(resolveAppBackgroundKind("")).toBe("none");
  });

  it("passes every kind it can actually draw through untouched", () => {
    expect(resolveAppBackgroundKind("none")).toBe("none");
    expect(resolveAppBackgroundKind("plain")).toBe("plain");
    expect(resolveAppBackgroundKind("gradient")).toBe("gradient");
    expect(resolveAppBackgroundKind("texture")).toBe("texture");
    expect(resolveAppBackgroundKind("effect")).toBe("effect");
  });

  it("does not confuse the two colourless modes", () => {
    // `none` draws the built-in pattern, `plain` draws nothing. Collapsing them
    // in either direction changes what a live cabinet looks like.
    expect(resolveAppBackgroundKind("none")).not.toBe(resolveAppBackgroundKind("plain"));
  });
});
