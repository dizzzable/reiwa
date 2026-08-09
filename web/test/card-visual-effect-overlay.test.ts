/**
 * Which effect gets a say in the card's text colour.
 *
 * Both card resolvers hand the animated effect's own colours to the contrast
 * pass, because an opaque effect is what the copy actually sits on: judging the
 * gradient alone puts white text over a white shader. Two rules govern that,
 * and each of them was broken in a different file.
 *
 * An effect this build cannot draw contributes NOTHING. `cardEffect` is open
 * vocabulary — a panel one release ahead can name an effect this bundle has no
 * component for, and the layer deliberately renders nothing for it so the
 * operator's gradient stays in view. But `resolveCardEffectOutputColors` answers
 * for an unknown id with the DEFAULT aurora palette, so contrast was choosing a
 * foreground, and the tariff card an extra veil, for purple-and-green artwork
 * that was never on the card.
 *
 * And an effect this build CAN draw must be taken into account — which the
 * tariff card did not do at all: it passed no overlay, so a plan card with an
 * opaque white effect picked its text colour from the gradient underneath.
 *
 * And an effect this build can draw but this CARD will not mount contributes
 * nothing either — the third form of the same mistake, and the reason the two
 * rules above were not enough. `tariff-card.tsx` suppresses the effect outright
 * when the plan carries an uploaded `textureUrl`, because the image is the
 * deliberate art for that card and the two would fight. The resolver did not
 * know, so such a plan got dark text and a raised veil sized for an animation
 * that never mounted: exactly the failure the first two rules had closed,
 * reopened through a different door.
 *
 * The controls in each block are load-bearing. Without them "unknown behaves
 * like NONE" would also pass if the overlay had simply been switched off, and
 * "an image suppresses the effect" would also pass if any texture at all did —
 * which would be wrong, because a preset grain sits on top of a live effect.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isKnownCardEffect } from "../src/components/reactbits/card-effect-catalog";
import { resolveSubscriptionCardVisual } from "../src/features/dashboard/components/subscription-card-visual";
import { resolvePlanCardStyle } from "../src/features/plans/plan-card-visual";
import {
  DEFAULT_BRANDING,
  type AppBackgroundTexture,
  type Branding,
  type CardEffect,
} from "../src/types/branding";

/** An id from a panel release this bundle has never seen. */
const UNKNOWN_EFFECT = "effectFromAFuturePanelRelease";
/** Ships here, palette `#ffffff`, and nothing about it leaves that palette. */
const WHITE_EFFECT = "threads";
const DARK_GRADIENT = "linear-gradient(135deg, #101014 0%, #17171d 100%)";
/** An operator-uploaded image, which the tariff card draws INSTEAD of the effect. */
const UPLOADED_IMAGE = "https://cdn.example.test/plan-art.png";

function subscriptionContrast(effect: string, opacity = 1) {
  return resolveSubscriptionCardVisual({
    ...DEFAULT_BRANDING,
    cardGradient: DARK_GRADIENT,
    cardEffect: effect as CardEffect,
    cardEffectOpacity: opacity,
  }).contrast;
}

function planContrast(
  effect: string,
  opacity = 1,
  texture: {
    readonly textureUrl?: string;
    readonly texturePreset?: AppBackgroundTexture;
  } = {},
) {
  const branding: Branding = {
    ...DEFAULT_BRANDING,
    planCardStyles: {
      "plan-1": {
        gradient: DARK_GRADIENT,
        cardEffect: effect as CardEffect,
        cardEffectOpacity: opacity,
        ...texture,
      },
    },
  };
  return resolvePlanCardStyle("plan-1", branding).contrast;
}

describe("the fixtures these tests are built on", () => {
  it("uses one effect this build ships and one it does not", () => {
    expect(isKnownCardEffect(WHITE_EFFECT)).toBe(true);
    expect(isKnownCardEffect(UNKNOWN_EFFECT)).toBe(false);
  });
});

describe("subscription card, effect it cannot draw", () => {
  it("contributes no overlay at all, exactly like NONE", () => {
    expect(subscriptionContrast(UNKNOWN_EFFECT)).toEqual(
      subscriptionContrast("NONE"),
    );
  });

  it("but an effect it CAN draw still changes the answer", () => {
    // Without this the assertion above would pass on a resolver that had
    // stopped considering effects altogether.
    expect(subscriptionContrast(WHITE_EFFECT)).not.toEqual(
      subscriptionContrast("NONE"),
    );
    expect(subscriptionContrast(WHITE_EFFECT).foregroundTone).toBe("dark");
  });
});

describe("tariff card, effect it cannot draw", () => {
  it("contributes neither colours nor the extra veil, exactly like NONE", () => {
    expect(planContrast(UNKNOWN_EFFECT)).toEqual(planContrast("NONE"));
  });

  it("but an effect it CAN draw still raises the veil floor", () => {
    expect(planContrast(WHITE_EFFECT).veilOpacity).toBeGreaterThan(
      planContrast("NONE").veilOpacity,
    );
  });
});

describe("tariff card, effect it can draw", () => {
  it("picks its text colour from the effect, not from the gradient beneath it", () => {
    // An opaque white shader over a near-black gradient. Reading the gradient
    // alone gives white-on-white.
    expect(planContrast(WHITE_EFFECT).foregroundTone).toBe("dark");
  });

  it("reads a nearly transparent effect as the gradient it barely covers", () => {
    // The other end of the same input: the effect is there, but the card is
    // still the operator's dark gradient, so the copy stays light.
    expect(planContrast(WHITE_EFFECT, 0.05).foregroundTone).toBe("light");
  });

  it("agrees with the subscription card on the same artwork", () => {
    // The two resolvers now ask contrast the same question. They differ only in
    // the tariff card's higher veil floor, so the chosen tone must match.
    expect(planContrast(WHITE_EFFECT).foregroundTone).toBe(
      subscriptionContrast(WHITE_EFFECT).foregroundTone,
    );
  });
});

describe("tariff card, effect on a plan that shows an uploaded image", () => {
  const withImage = { textureUrl: UPLOADED_IMAGE } as const;

  it("contributes nothing, because that card never mounts the effect", () => {
    expect(planContrast(WHITE_EFFECT, 1, withImage)).toEqual(
      planContrast("NONE", 1, withImage),
    );
  });

  it("does not darken the card for artwork that is never drawn", () => {
    // The visible half of the same bug: an opaque white effect flipped the copy
    // to dark and raised the veil, over a card showing the operator's image on
    // a near-black gradient.
    expect(planContrast(WHITE_EFFECT, 1, withImage).foregroundTone).toBe(
      "light",
    );
    expect(planContrast(WHITE_EFFECT, 1, withImage).veilOpacity).toBe(
      planContrast("NONE", 1, withImage).veilOpacity,
    );
  });

  it("but the same effect on a plan WITHOUT the image still counts", () => {
    // Without this the assertions above would pass on a resolver that had
    // stopped considering effects on tariff cards altogether.
    expect(planContrast(WHITE_EFFECT)).not.toEqual(planContrast("NONE"));
  });

  it("and a preset grain does NOT suppress it, because the card still draws both", () => {
    // The other control, and the reason this is `textureUrl` rather than "any
    // texture": a built-in pattern is a subtle overlay drawn ON TOP of a live
    // effect, so it suppresses nothing.
    const preset = { texturePreset: "diagonal" } as const;

    expect(planContrast(WHITE_EFFECT, 1, preset)).not.toEqual(
      planContrast("NONE", 1, preset),
    );
    expect(planContrast(WHITE_EFFECT, 1, preset)).toEqual(
      planContrast(WHITE_EFFECT),
    );
  });

  it("mirrors the suppression rule the tariff card actually applies", () => {
    // The two are separate files with no shared expression, so nothing but this
    // stops them drifting again. If the card's rule moves, this fails and says
    // where the resolver has to follow.
    const tariffCard = readFileSync(
      new URL("../src/features/plans/tariff-card.tsx", import.meta.url),
      "utf8",
    );

    expect(tariffCard).toContain(
      'const showEffect = effect !== "NONE" && !visual.textureUrl;',
    );
  });
});
