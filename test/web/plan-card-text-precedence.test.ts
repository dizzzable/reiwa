import { describe, expect, it } from "vitest";

import { resolveSubscriptionCardVisual } from "@/features/dashboard/components/subscription-card-visual";
import { resolvePlanCardStyle } from "@/features/plans/plan-card-visual";
import { resolveCardContrast } from "@/lib/card-contrast";
import {
  DEFAULT_BRANDING,
  resolveCardTextForeground,
  resolvePlanCardText,
  type Branding,
  type PlanCardText,
  type SubscriptionCardText,
} from "@/types/branding";

/**
 * Which text colour a tariff card ends up with.
 *
 * The rule the owner asked for is one sentence — a tariff card inherits the
 * subscription card's text setting, and each plan may override it — and every
 * case here is about a way that sentence can go wrong quietly:
 *
 *   - "inherits" must include the plans nobody has ever configured, which are
 *     almost all of them. Their entries carry no `text` key at all, so ABSENCE
 *     is the main input to this code, not an edge case;
 *   - the inherited default is `auto`, which means the card must fall all the
 *     way back to the contrast computation it used before this field existed.
 *     A regression there is invisible in a green suite that only asserts forced
 *     colours, so the first case compares the resolver's output against a
 *     hand-built call that omits the new option entirely;
 *   - an override must be able to go BACK to automatic (`auto`) while the
 *     global forces a colour. That is why `inherit` and `auto` are two values.
 *
 * The contrast machinery itself is not under test here — `card-contrast.test.ts`
 * owns that. What is under test is which of its inputs this code chooses.
 */

const DARK_GRADIENT = "linear-gradient(90deg,#111,#222)";
const LIGHT_GRADIENT = "linear-gradient(90deg,#f8fafc,#e2e8f0)";
const PLAN_ID = "plan_alpha";

function brandingWith(
  planStyle: Record<string, unknown> | undefined,
  subscriptionCardText: SubscriptionCardText = { mode: "auto", color: null },
  gradient = DARK_GRADIENT,
): Branding {
  return {
    ...DEFAULT_BRANDING,
    subscriptionCardText,
    planCardStyles: planStyle === undefined ? {} : { [PLAN_ID]: { gradient, ...planStyle } },
  } as Branding;
}

describe("resolvePlanCardText precedence", () => {
  const global: SubscriptionCardText = { mode: "dark", color: null };

  it("falls back to the global policy for every spelling of 'no per-plan decision'", () => {
    // All five mean the same thing, and they arrive from different eras: no key
    // (pre-control snapshots), an explicit null (a cleared patch), inherit (the
    // operator said so), an unknown mode (a panel one release ahead), and a
    // custom with no usable colour (a half-finished edit that reached storage).
    const noDecision: ReadonlyArray<PlanCardText | null | undefined> = [
      undefined,
      null,
      { mode: "inherit", color: null },
      { mode: "gradient-aware", color: null } as unknown as PlanCardText,
      { mode: "custom", color: null },
      { mode: "custom", color: "#22c55eff" },
      { mode: "custom", color: "not-a-colour" },
    ];
    for (const value of noDecision) {
      expect(resolvePlanCardText(value, global), JSON.stringify(value)).toEqual(global);
    }
  });

  it("normalises an explicit per-plan decision exactly as the global control does", () => {
    expect(resolvePlanCardText({ mode: "auto", color: null }, global)).toEqual({
      mode: "auto",
      color: null,
    });
    // A stale colour left on a non-custom mode is dropped, so the two cards
    // cannot disagree about what the mode means.
    expect(resolvePlanCardText({ mode: "light", color: "#ff0000" }, global)).toEqual({
      mode: "light",
      color: null,
    });
    expect(resolvePlanCardText({ mode: "custom", color: "  #22c55e  " }, global)).toEqual({
      mode: "custom",
      color: "#22c55e",
    });
  });

  it("treats a missing global policy as the shipping default", () => {
    // A cached snapshot from before the global control existed carries no
    // `subscriptionCardText` at all; an inheriting card must still land on
    // `auto` rather than on undefined.
    expect(resolvePlanCardText(undefined, undefined)).toEqual({ mode: "auto", color: null });
    expect(resolvePlanCardText({ mode: "inherit", color: null }, null)).toEqual({
      mode: "auto",
      color: null,
    });
  });
});

describe("tariff card foreground", () => {
  it("is byte-identical to the pre-feature call when nothing was configured", () => {
    // THE compatibility assertion. An installation that has touched neither
    // control resolves `forcedForeground` to null, and a null forced foreground
    // is what `resolveCardContrast` already does when the option is absent — so
    // the whole contrast object must equal the one the previous release
    // produced, not merely agree about the foreground.
    for (const gradient of [DARK_GRADIENT, LIGHT_GRADIENT]) {
      const resolved = resolvePlanCardStyle(PLAN_ID, brandingWith(undefined, undefined, gradient));
      const asItShipped = resolveCardContrast(resolved.gradient, {
        fallbackBackground: DEFAULT_BRANDING.bgSecondary,
        preferredForeground: DEFAULT_BRANDING.primaryFg,
        minimumVeilOpacity: 0.12,
        overlayArtwork: null,
        overlayOpacity: 0,
      });
      expect(resolved.contrast, gradient).toEqual(asItShipped);
    }
  });

  it("still computes automatic contrast from the artwork, both ways", () => {
    // Guards the case a hard-coded "#ffffff" would sail through: light artwork
    // has to produce dark copy.
    expect(resolvePlanCardStyle(PLAN_ID, brandingWith({}, undefined, DARK_GRADIENT)).contrast
      .foreground).toBe("#ffffff");
    expect(resolvePlanCardStyle(PLAN_ID, brandingWith({}, undefined, LIGHT_GRADIENT)).contrast
      .foreground).toBe("#0a0a0a");
  });

  it("inherits the global policy on a card that has no text of its own", () => {
    const cases: ReadonlyArray<readonly [SubscriptionCardText, string]> = [
      [{ mode: "light", color: null }, "#ffffff"],
      [{ mode: "dark", color: null }, "#0a0a0a"],
      [{ mode: "custom", color: "#ff00ff" }, "#ff00ff"],
    ];
    for (const [subscriptionCardText, foreground] of cases) {
      // Light artwork throughout: automatic contrast would pick #0a0a0a here,
      // so `light` and `custom` passing proves the global policy is actually
      // being consulted rather than coincidentally matching.
      const resolved = resolvePlanCardStyle(
        PLAN_ID,
        brandingWith({}, subscriptionCardText, LIGHT_GRADIENT),
      );
      expect(resolved.contrast.foreground, subscriptionCardText.mode).toBe(foreground);
    }
  });

  it("lets one plan override the global policy, including back to automatic", () => {
    const global: SubscriptionCardText = { mode: "light", color: null };
    const override = (text: PlanCardText) =>
      resolvePlanCardStyle(PLAN_ID, brandingWith({ text }, global, LIGHT_GRADIENT)).contrast
        .foreground;

    expect(override({ mode: "dark", color: null })).toBe("#0a0a0a");
    expect(override({ mode: "custom", color: "#123456" })).toBe("#123456");
    // The reason `auto` exists as a separate value from `inherit`: the global
    // forces light copy, and this one card computes from its own light artwork
    // instead — which yields dark copy.
    expect(override({ mode: "auto", color: null })).toBe("#0a0a0a");
    // And inherit is still the global.
    expect(override({ mode: "inherit", color: null })).toBe("#ffffff");
  });

  it("gives an inheriting tariff card the same foreground as the subscription card", () => {
    // What "inherits the subscription card's setting" has to mean literally.
    // The two cards run different resolvers over the same artwork, and the
    // light/dark hex pair lives in one shared helper precisely so this holds.
    for (const subscriptionCardText of [
      { mode: "light", color: null },
      { mode: "dark", color: null },
      { mode: "custom", color: "#abcdef" },
    ] as const) {
      const branding = brandingWith({}, subscriptionCardText, DARK_GRADIENT);
      const card = resolveSubscriptionCardVisual({
        ...branding,
        cardGradient: DARK_GRADIENT,
        cardEffect: "NONE",
      } as Branding);
      const tariff = resolvePlanCardStyle(PLAN_ID, branding);
      expect(tariff.contrast.foreground, subscriptionCardText.mode).toBe(
        card.contrast.foreground,
      );
    }
  });

  it("keeps the effect overlay in the contrast inputs while forcing a colour", () => {
    // The veil is still computed from the real artwork, including an animated
    // layer over it. A forced foreground decides the COLOUR, never whether the
    // card needs support behind it — see the three-times-over note in
    // `plan-card-visual.ts`.
    const withEffect = resolvePlanCardStyle(
      PLAN_ID,
      brandingWith(
        {
          text: { mode: "light", color: null },
          cardEffect: "aurora",
          cardEffectProps: {},
          cardEffectOpacity: 1,
        },
        undefined,
        LIGHT_GRADIENT,
      ),
    );
    expect(withEffect.contrast.foreground).toBe("#ffffff");
    expect(withEffect.contrast.veilOpacity).toBeGreaterThanOrEqual(0.18);
  });

  it("reports the policy the card ended up on", () => {
    // `resolvePlanCardStyle` exposes the resolved decision, not the raw one, so
    // a caller cannot re-derive precedence and get a different answer.
    expect(
      resolvePlanCardStyle(PLAN_ID, brandingWith({ text: { mode: "inherit", color: null } }, {
        mode: "custom",
        color: "#0f172a",
      })).text,
    ).toEqual({ mode: "custom", color: "#0f172a" });
  });
});

describe("resolveCardTextForeground", () => {
  it("maps each mode to the literal both cards use", () => {
    expect(resolveCardTextForeground({ mode: "auto", color: null })).toBeNull();
    expect(resolveCardTextForeground({ mode: "light", color: null })).toBe("#ffffff");
    expect(resolveCardTextForeground({ mode: "dark", color: null })).toBe("#0a0a0a");
    expect(resolveCardTextForeground({ mode: "custom", color: "#22c55e" })).toBe("#22c55e");
  });
});
