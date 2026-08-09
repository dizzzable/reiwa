import { describe, expect, it } from "vitest";

import { isPublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port.js";
import { DEFAULT_PUBLIC_CONFIG } from "../../web/src/types/branding.js";

/**
 * A newer panel must not be able to freeze an older cabinet.
 *
 * `isPublicConfigSnapshot` is a single `&&` chain, and it used to check
 * `cardEffect` against a hard-coded list of the effects this build ships. The
 * two repositories release separately, so the moment rezeis-admin gained an
 * effect the cabinet had not yet learned, one decorative field made the WHOLE
 * snapshot invalid. The fetch threw before reaching `save`, so the last stored
 * snapshot was served on — not until a restart, indefinitely — and every later
 * branding edit, colours and logo and texts alike, vanished without a word
 * while the panel reported success.
 *
 * These tests fix the shape of the escape: unknown effect names travel, and
 * are resolved where they are used. The consuming half of the contract lives
 * in `web/test/card-effect-unknown-id.test.tsx`.
 *
 * The `NOT_A_REAL_EFFECT` name is deliberately absurd. If someone later adds an
 * effect that happens to be called that, the test does not silently stop
 * testing anything — it starts testing a known id, and the companion test that
 * asserts it renders nothing will fail loudly.
 */

const NOT_A_REAL_EFFECT = "effectFromAFuturePanelRelease";

function withBranding(overrides: Record<string, unknown>): unknown {
  return {
    ...DEFAULT_PUBLIC_CONFIG,
    branding: { ...DEFAULT_PUBLIC_CONFIG.branding, ...overrides },
  };
}

describe("card effect open vocabulary", () => {
  it("accepts a snapshot naming an effect this build has never heard of", () => {
    expect(isPublicConfigSnapshot(withBranding({ cardEffect: NOT_A_REAL_EFFECT }))).toBe(true);
  });

  it("accepts the unknown name on a per-position card slot", () => {
    const config = withBranding({
      cardEffectsByIndex: [
        {
          mode: "override",
          cardEffect: NOT_A_REAL_EFFECT,
          cardEffectProps: {},
          cardEffectOpacity: 1,
          cardGradient: null,
        },
      ],
    });

    expect(isPublicConfigSnapshot(config)).toBe(true);
  });

  it("accepts the unknown name on the app background", () => {
    const config = withBranding({
      appBackground: {
        ...DEFAULT_PUBLIC_CONFIG.branding.appBackground,
        kind: "effect",
        effect: NOT_A_REAL_EFFECT,
      },
    });

    expect(isPublicConfigSnapshot(config)).toBe(true);
  });

  it("accepts the unknown name on a plan card style", () => {
    const config = withBranding({
      planCardStyles: { starter: { cardEffect: NOT_A_REAL_EFFECT } },
    });

    expect(isPublicConfigSnapshot(config)).toBe(true);
  });

  it("accepts the unknown name inside a light/dark theme variant", () => {
    // The defaults ship no variants, so build one from the root branding —
    // that is also the shape rezeis-admin writes when a concept is applied.
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
    const baseline = withBranding({ themeVariants: { light: variant, dark: variant } });
    // Guards the fixture itself: if the variant shape were incomplete, the
    // test below would pass for the wrong reason on the very next release.
    expect(isPublicConfigSnapshot(baseline)).toBe(true);

    const config = withBranding({
      themeVariants: {
        light: variant,
        dark: { ...variant, cardEffect: NOT_A_REAL_EFFECT },
      },
    });

    expect(isPublicConfigSnapshot(config)).toBe(true);
  });

  /**
   * Tolerance is not absence of checking. Without these the guard would be a
   * no-op that passes the tests above for the wrong reason.
   */
  it.each([
    ["a missing effect", undefined],
    ["a null effect", null],
    ["an empty name", ""],
    ["a number", 7],
    ["an object", { effect: "aurora" }],
    ["a name longer than any real identifier", "e".repeat(65)],
  ])("still rejects %s", (_label, value) => {
    expect(isPublicConfigSnapshot(withBranding({ cardEffect: value }))).toBe(false);
  });

  it("keeps the neighbouring closed enums closed", () => {
    // `bgEffect` is a legacy set that has not gained a member since it was
    // introduced. Loosening the card effect must not have loosened it too.
    expect(isPublicConfigSnapshot(withBranding({ bgEffect: "SOMETHING_NEW" }))).toBe(false);
    expect(isPublicConfigSnapshot(withBranding({ borderRadius: "enormous" }))).toBe(false);
  });

  it("carries the unknown name through verbatim rather than rewriting it", () => {
    // The cabinet stores what it was given. Coercing to a known effect here
    // would make the panel and the cabinet disagree about what is configured,
    // and the operator would never learn their choice had not taken effect.
    const config = withBranding({ cardEffect: NOT_A_REAL_EFFECT });
    if (!isPublicConfigSnapshot(config)) throw new Error("fixture must be valid");

    expect(config.branding["cardEffect"]).toBe(NOT_A_REAL_EFFECT);
  });
});
