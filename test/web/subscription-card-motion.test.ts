import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_CREATION_TIMING,
  resolveNextSubscriptionCreationWake,
  resolveSubscriptionCreationState,
} from "../../web/src/features/dashboard/components/subscription-card-motion-policy.js";
import {
  resolveSubscriptionCardVisual,
} from "../../web/src/features/dashboard/components/subscription-card-visual.js";
import {
  DEFAULT_BRANDING,
  resolveSubscriptionCardText,
  type Branding,
  type CardEffectSlot,
} from "../../web/src/types/branding.js";

function branding(overrides: Partial<Branding> = {}): Branding {
  return {
    ...DEFAULT_BRANDING,
    cardEffectProps: { ...DEFAULT_BRANDING.cardEffectProps },
    cardEffectsByIndex: [...DEFAULT_BRANDING.cardEffectsByIndex],
    ...overrides,
  };
}

describe("subscription card visual resolver", () => {
  it("resolves a positional slot without parsing operator props or gradients", () => {
    const colorStops = [
      "#101010",
      "#202020",
      "#303030",
      "#404040",
      "#505050",
    ];
    const visual = resolveSubscriptionCardVisual(
      branding({
        cardEffect: "threads",
        cardGradient: "linear-gradient(red, blue)",
        cardEffectProps: { amplitude: 4 },
        cardEffectOpacity: 0.42,
        cardEffectsByIndex: [
          {
            mode: "override",
            cardEffect: "aurora",
            cardEffectProps: { colorStops, custom: { nested: true } },
            cardEffectOpacity: 0.73,
            cardGradient: "var(--operator-owned-gradient)",
          },
        ],
      }),
      0,
    );

    expect(visual.slotIndex).toBe(0);
    expect(visual.cardEffect).toBe("aurora");
    expect(visual.cardEffectOpacity).toBe(0.73);
    expect(visual.cardGradient).toBe("var(--operator-owned-gradient)");
    expect(visual.cardEffectProps["colorStops"]).toBe(colorStops);
    expect(visual.cardEffectProps).toMatchObject({
      custom: { nested: true },
    });
  });

  it("falls back to global settings for an empty slot gradient", () => {
    const visual = resolveSubscriptionCardVisual(
      branding({
        cardEffect: "waves",
        cardGradient: "linear-gradient(12deg, black, white)",
        cardEffectProps: { speed: 3 },
        cardEffectOpacity: 0.64,
        cardEffectsByIndex: [
          {
            mode: "override",
            cardEffect: "waves",
            cardEffectProps: { speed: 2 },
            cardEffectOpacity: 0.5,
            cardGradient: "   ",
          },
        ],
      }),
      0,
    );

    expect(visual.cardGradient).toBe(
      "linear-gradient(12deg, black, white)",
    );
    expect(visual.cardEffectProps).toEqual({ speed: 2 });
  });

  it("resolves distinct positional visuals and falls back globally after the last slot", () => {
    const source = branding({
      cardEffect: "silk",
      cardEffectProps: { speed: 9 },
      cardEffectOpacity: 0.91,
      cardGradient: "linear-gradient(135deg, #111827, #7c3aed)",
      cardEffectsByIndex: [
        {
          mode: "override",
          cardEffect: "aurora",
          cardEffectProps: { amplitude: 1 },
          cardEffectOpacity: 0.51,
          cardGradient: "linear-gradient(135deg, #7f1d1d, #ef4444)",
        },
        {
          mode: "override",
          cardEffect: "waves",
          cardEffectProps: { speed: 2 },
          cardEffectOpacity: 0.72,
          cardGradient: "linear-gradient(135deg, #0c4a6e, #22d3ee)",
        },
      ],
    });

    const first = resolveSubscriptionCardVisual(source, 0);
    const second = resolveSubscriptionCardVisual(source, 1);
    const third = resolveSubscriptionCardVisual(source, 2);

    expect(first).toMatchObject({
      slotIndex: 0,
      cardEffect: "aurora",
      cardEffectOpacity: 0.51,
      cardGradient: "linear-gradient(135deg, #7f1d1d, #ef4444)",
    });
    expect(second).toMatchObject({
      slotIndex: 1,
      cardEffect: "waves",
      cardEffectOpacity: 0.72,
      cardGradient: "linear-gradient(135deg, #0c4a6e, #22d3ee)",
    });
    expect(third).toMatchObject({
      slotIndex: 2,
      cardEffect: "silk",
      cardEffectOpacity: 0.91,
      cardGradient: "linear-gradient(135deg, #111827, #7c3aed)",
    });
  });

  it("freezes the operator card pattern into the resolved visual snapshot", () => {
    const pattern =
      "linear-gradient(#ffffff22 1px, transparent 1px), linear-gradient(90deg, #ffffff22 1px, transparent 1px)";
    const visual = resolveSubscriptionCardVisual(
      branding({ cardPattern: pattern }),
      2,
    );

    expect(visual.cardPattern).toBe(pattern);
    expect(resolveSubscriptionCardVisual(branding({ cardPattern: null })).cardPattern).toBeNull();
  });

  it("freezes light and dark card contrast into the visual snapshot", () => {
    const light = resolveSubscriptionCardVisual(
      branding({
        primaryFg: "#0a0a0a",
        bgSecondary: "#f8fafc",
        cardGradient:
          "linear-gradient(135deg, #fff7ed, #fde68a, #f8fafc)",
      }),
    );
    const dark = resolveSubscriptionCardVisual(
      branding({
        primaryFg: "#ffffff",
        bgSecondary: "#09090b",
        cardGradient:
          "linear-gradient(135deg, #020617, #172554, #1e1b4b)",
      }),
    );

    expect(light.contrast).toMatchObject({
      foregroundTone: "dark",
      foreground: "#0a0a0a",
      veilRgb: "255 255 255",
    });
    expect(dark.contrast).toMatchObject({
      foregroundTone: "light",
      foreground: "#ffffff",
      veilRgb: "0 0 0",
    });
  });

  it.each([
    ["auto", null, "#ffffff"],
    ["light", null, "#ffffff"],
    ["dark", null, "#0a0a0a"],
    ["custom", "#1b2c3d", "#1b2c3d"],
  ] as const)(
    "respects the operator's %s subscription-card text policy",
    (mode, color, expectedForeground) => {
      const visual = resolveSubscriptionCardVisual(
        branding({
          primaryFg: "#0a0a0a",
          cardGradient: "linear-gradient(135deg, #020617, #172554)",
          subscriptionCardText: { mode, color },
        }),
      );

      expect(visual.subscriptionCardText).toEqual({ mode, color });
      expect(visual.contrast.foreground).toBe(expectedForeground);
    },
  );

  it("defaults a legacy missing text policy to automatic contrast", () => {
    const visual = resolveSubscriptionCardVisual(
      branding({
        subscriptionCardText: undefined,
        primaryFg: "#ffffff",
        cardGradient: "linear-gradient(135deg, #020617, #172554)",
      }),
    );

    expect(visual.subscriptionCardText).toEqual({ mode: "auto", color: null });
    expect(visual.contrast.foreground).toBe("#ffffff");
  });

  it("normalizes malformed legacy custom text settings to automatic contrast", () => {
    expect(
      resolveSubscriptionCardText({ mode: "custom", color: null }),
    ).toEqual({ mode: "auto", color: null });
    expect(
      resolveSubscriptionCardText({ mode: "custom", color: "rgb(1, 2, 3)" }),
    ).toEqual({ mode: "auto", color: null });
    expect(
      resolveSubscriptionCardText({ mode: "custom", color: "#f8fafc80" }),
    ).toEqual({ mode: "auto", color: null });
    expect(
      resolveSubscriptionCardText({ mode: "dark", color: "#f8fafc" }),
    ).toEqual({ mode: "dark", color: null });
  });

  it("keeps text policy global while a positional effect/gradient overrides artwork", () => {
    const visual = resolveSubscriptionCardVisual(
      branding({
        subscriptionCardText: { mode: "custom", color: "#f8fafc" },
        cardEffectsByIndex: [
        {
            mode: "override",
            cardEffect: "paperWarp",
            cardEffectProps: { colors: ["#0a1020", "#f72585"] },
            cardEffectOpacity: 0.68,
            cardGradient: "linear-gradient(135deg, #052e16, #0f766e)",
          },
        ],
      }),
      0,
    );

    expect(visual.cardGradient).toBe("linear-gradient(135deg, #052e16, #0f766e)");
    expect(visual.cardEffect).toBe("paperWarp");
    expect(visual.cardEffectOpacity).toBe(0.68);
    expect(visual.contrast.foreground).toBe("#f8fafc");
  });

  it("does not add a desaturating veil merely because an animated effect exists", () => {
    const gradient =
      "linear-gradient(135deg, #ff1744 0%, #651fff 48%, #00e5ff 100%)";
    const colorStops = ["#ff1744", "#651fff", "#00e5ff"];
    const staticVisual = resolveSubscriptionCardVisual(
      branding({
        cardGradient: gradient,
        cardEffect: "NONE",
        cardEffectProps: {},
      }),
    );
    const animatedVisual = resolveSubscriptionCardVisual(
      branding({
        cardGradient: gradient,
        cardEffect: "aurora",
        cardEffectProps: { colorStops },
        cardEffectOpacity: 0.84,
      }),
    );

    expect(animatedVisual.cardGradient).toBe(gradient);
    expect(animatedVisual.cardEffectProps["colorStops"]).toBe(colorStops);
    expect(animatedVisual.cardEffectOpacity).toBe(0.84);
    expect(animatedVisual.contrast.veilOpacity).toBe(
      staticVisual.contrast.veilOpacity,
    );
    expect(animatedVisual.contrast.overlayBackground).toBe(
      staticVisual.contrast.overlayBackground,
    );
  });

  it("gives a global operator effect priority over legacy and inherited slots", () => {
    const visual = resolveSubscriptionCardVisual(
      branding({
        cardEffect: "paperGrain",
        cardEffectProps: { colors: ["#101010", "#f72585"], noise: 0.4 },
        cardEffectOpacity: 0.82,
        cardEffectsByIndex: [
          // Older concept payloads carried complete values but no explicit
          // operator opt-in. They must no longer shadow the global controls.
          {
            cardEffect: "paperWarp",
            cardEffectProps: { shape: "stripes" },
            cardEffectOpacity: 0.2,
            cardGradient: "linear-gradient(90deg, red, blue)",
          },
          { mode: "inherit", cardGradient: null },
        ],
      }),
      0,
    );

    expect(visual.cardEffect).toBe("paperGrain");
    expect(visual.cardEffectOpacity).toBe(0.82);
    expect(visual.cardEffectProps).toEqual({
      colors: ["#101010", "#f72585"],
      noise: 0.4,
    });
    // Static per-position gradients remain a separate explicit visual choice.
    expect(visual.cardGradient).toBe("linear-gradient(90deg, red, blue)");
  });

  it("injects Aurora defaults only when colorStops are absent", () => {
    const injected = resolveSubscriptionCardVisual(
      branding({
        primary: "#2468ac",
        cardEffect: "aurora",
        cardEffectProps: { speed: 2.5 },
      }),
    );
    expect(injected.cardEffectProps["colorStops"]).toHaveLength(3);
    expect(injected.cardEffectProps["speed"]).toBe(2.5);

    const explicitStops = ["#1", "#2", "#3", "#4"];
    const preserved = resolveSubscriptionCardVisual(
      branding({
        cardEffect: "aurora",
        cardEffectProps: { colorStops: explicitStops },
      }),
    );
    expect(preserved.cardEffectProps["colorStops"]).toBe(explicitStops);
  });

  it("keeps alpha-bearing primary values theme-derived for Aurora", () => {
    const shortAlpha = resolveSubscriptionCardVisual(
      branding({ primary: "#1234", cardEffect: "aurora" }),
    );
    const longAlpha = resolveSubscriptionCardVisual(
      branding({ primary: "#11223344", cardEffect: "aurora" }),
    );
    const opaque = resolveSubscriptionCardVisual(
      branding({ primary: "#112233", cardEffect: "aurora" }),
    );

    expect(shortAlpha.primary).toBe("#1234");
    expect(longAlpha.primary).toBe("#11223344");
    expect(shortAlpha.cardEffectProps["colorStops"]).toEqual(
      opaque.cardEffectProps["colorStops"],
    );
    expect(longAlpha.cardEffectProps["colorStops"]).toEqual(
      opaque.cardEffectProps["colorStops"],
    );
  });

  it("ignores invalid slot indexes", () => {
    const visual = resolveSubscriptionCardVisual(
      branding({ cardEffect: "silk" }),
      -1,
    );
    expect(visual.slotIndex).toBeNull();
    expect(visual.cardEffect).toBe("silk");
  });
});

/**
 * The third off switch: "turn THIS card off".
 *
 * The operator has three of them and they are not interchangeable. The global
 * `cardEffect: "NONE"` stops every card; a tariff's `planCardStyles[id]`
 * answers for one plan's card; and a positional slot marked `override` with
 * `cardEffect: "NONE"` darkens the Nth subscription card WHILE the global
 * effect keeps running on all the others. Only the third one can express that,
 * so nothing else in the suite can stand in for it.
 *
 * It was the only one of the three with no test at all. `override + NONE`
 * could be made to fall through to the global effect — one added condition in
 * `subscription-card-visual.ts` — and every card-effect suite stayed green:
 * the existing positional tests all name a real effect in the slot, which
 * takes the same branch whether or not `NONE` is excluded from it.
 *
 * Each case below is written against its own neighbour: the silenced card is
 * always checked next to a card that is NOT silenced, so none of these can pass
 * on a resolver that simply stopped reading slots.
 */
describe("positional slot as the per-card off switch", () => {
  /** Ships in this bundle, and paints an opaque white — see `card-visual-effect-overlay`. */
  const LIT = "threads";
  const DARK_GRADIENT = "linear-gradient(135deg, #101014 0%, #17171d 100%)";
  /**
   * "This card off", in the shape the panel actually publishes it.
   *
   * The props and the opacity are not padding: `isCardEffectSlot` in the
   * public-config guard requires an `override` slot to be structurally
   * complete even when its effect is `NONE`, so a slot without them describes
   * a payload the cabinet can never be served.
   */
  const SILENCED_SLOT: CardEffectSlot = {
    mode: "override",
    cardEffect: "NONE",
    cardEffectProps: {},
    cardEffectOpacity: 1,
  };

  function card(index: number, overrides: Partial<Branding>) {
    return resolveSubscriptionCardVisual(
      branding({ cardGradient: DARK_GRADIENT, ...overrides }),
      index,
    );
  }

  it("silences its own card while the global effect keeps the neighbours", () => {
    const source: Partial<Branding> = {
      cardEffect: "aurora",
      cardEffectProps: { amplitude: 7 },
      cardEffectOpacity: 1,
      cardEffectsByIndex: [SILENCED_SLOT],
    };

    const silenced = card(0, source);
    const neighbour = card(1, source);

    expect(silenced.cardEffect).toBe("NONE");
    // Not merely a different name: nothing of the global effect may be left on
    // this card. Aurora injects its brand-derived stops on the way through, so
    // a card that fell back to it carries them even where the id is corrected
    // afterwards.
    expect(silenced.cardEffectProps).toEqual({});
    expect(neighbour.cardEffect).toBe("aurora");
    expect(neighbour.cardEffectProps["colorStops"]).toHaveLength(3);
    expect(neighbour.cardEffectProps["amplitude"]).toBe(7);
  });

  it("keeps the artwork it is not wearing out of its contrast decision", () => {
    // The invisible half. `threads` is an opaque white shader, so a card that
    // wears it takes DARK copy over this near-black gradient. A silenced card
    // that still handed the effect to contrast would read as light-on-light
    // artwork it never draws.
    const source: Partial<Branding> = {
      cardEffect: LIT,
      cardEffectsByIndex: [SILENCED_SLOT],
    };

    const silenced = card(0, source);
    const neighbour = card(1, source);
    const globallyOff = card(0, { cardEffect: "NONE" });

    expect(silenced.contrast).toEqual(globallyOff.contrast);
    expect(silenced.contrast.foregroundTone).toBe("light");
    // The control: without it the line above would also pass on a resolver
    // that had stopped giving effects to contrast altogether.
    expect(neighbour.contrast).not.toEqual(globallyOff.contrast);
    expect(neighbour.contrast.foregroundTone).toBe("dark");
  });

  it("lights its own card while the global effect is off", () => {
    // The same switch used the other way round, and the reason "a slot may
    // only narrow the global effect" is not the rule here.
    const source: Partial<Branding> = {
      cardEffect: "NONE",
      cardEffectsByIndex: [
        {
          mode: "override",
          cardEffect: LIT,
          cardEffectProps: { amplitude: 2 },
          cardEffectOpacity: 0.6,
        },
      ],
    };

    const lit = card(0, source);

    expect(lit).toMatchObject({ cardEffect: LIT, cardEffectOpacity: 0.6 });
    expect(lit.cardEffectProps).toEqual({ amplitude: 2 });
    expect(card(1, source).cardEffect).toBe("NONE");
  });

  it("lets an inherit slot follow a later global edit, whatever it still holds", () => {
    // A concept used to populate every slot, so live installs carry slots full
    // of values the operator never chose. `inherit` means the global controls
    // are authoritative again — including when the stale copy says `NONE`,
    // which must not switch a card off the operator did not switch off.
    const source: Partial<Branding> = {
      cardEffect: "silk",
      cardEffectProps: { speed: 4 },
      cardEffectOpacity: 0.9,
      cardEffectsByIndex: [
        {
          mode: "inherit",
          cardEffect: "aurora",
          cardEffectProps: { amplitude: 3 },
          cardEffectOpacity: 0.1,
        },
        { mode: "inherit", cardEffect: "NONE" },
      ],
    };

    for (const index of [0, 1]) {
      const visual = card(index, source);
      expect(visual).toMatchObject({
        slotIndex: index,
        cardEffect: "silk",
        cardEffectOpacity: 0.9,
      });
      expect(visual.cardEffectProps).toEqual({ speed: 4 });
    }
  });

  it("takes the global effect for every card past the last configured slot", () => {
    // A silenced first card must not silence the list. Slots are positional,
    // and the array simply ends.
    const source: Partial<Branding> = {
      cardEffect: "silk",
      cardEffectProps: { speed: 4 },
      cardEffectOpacity: 0.77,
      cardEffectsByIndex: [SILENCED_SLOT],
    };

    expect(card(0, source).cardEffect).toBe("NONE");
    for (const index of [1, 2, 9]) {
      expect(card(index, source)).toMatchObject({
        slotIndex: index,
        cardEffect: "silk",
        cardEffectOpacity: 0.77,
      });
    }
  });
});

describe("subscription creation timeline", () => {
  const pending = {
    backendReady: false,
    readySubscriptionAvailable: false,
  } as const;

  it.each([
    [0, "frame"],
    [SUBSCRIPTION_CREATION_TIMING.surface, "surface"],
    [SUBSCRIPTION_CREATION_TIMING.identity, "identity"],
    [SUBSCRIPTION_CREATION_TIMING.modules, "modules"],
    [SUBSCRIPTION_CREATION_TIMING.ignition, "ignition"],
    [SUBSCRIPTION_CREATION_TIMING.docking, "docking"],
    [SUBSCRIPTION_CREATION_TIMING.waiting, "waiting"],
  ] as const)("maps %i ms to %s", (elapsedMs, stage) => {
    expect(
      resolveSubscriptionCreationState({ elapsedMs, ...pending }).stage,
    ).toBe(stage);
  });

  it("does not hand off on backend READY before the real item exists", () => {
    const state = resolveSubscriptionCreationState({
      elapsedMs: 20_000,
      backendReady: true,
      readySubscriptionAvailable: false,
      readySinceMs: 2_000,
    });
    expect(state).toMatchObject({ stage: "waiting", complete: false });
  });

  it("keeps the full assembly sequence visible when READY arrives early", () => {
    const before = resolveSubscriptionCreationState({
      elapsedMs: SUBSCRIPTION_CREATION_TIMING.waiting - 1,
      backendReady: true,
      readySubscriptionAvailable: true,
      readySinceMs: 0,
    });
    const complete = resolveSubscriptionCreationState({
      elapsedMs: SUBSCRIPTION_CREATION_TIMING.waiting,
      backendReady: true,
      readySubscriptionAvailable: true,
      readySinceMs: 0,
    });

    expect(before).toMatchObject({ stage: "docking", complete: false });
    expect(complete).toMatchObject({ stage: "complete", complete: true });
  });

  it("uses a short docking handoff after a long wait", () => {
    const readySinceMs = 9_000;
    expect(
      resolveSubscriptionCreationState({
        elapsedMs:
          readySinceMs +
          SUBSCRIPTION_CREATION_TIMING.lateReadyHandoff -
          1,
        backendReady: true,
        readySubscriptionAvailable: true,
        readySinceMs,
      }).complete,
    ).toBe(false);
    expect(
      resolveSubscriptionCreationState({
        elapsedMs:
          readySinceMs +
          SUBSCRIPTION_CREATION_TIMING.lateReadyHandoff,
        backendReady: true,
        readySubscriptionAvailable: true,
        readySinceMs,
      }).complete,
    ).toBe(true);
  });

  it("uses a short opacity-only sequence in reduced mode but still requires real data", () => {
    expect(
      resolveSubscriptionCreationState({
        elapsedMs: SUBSCRIPTION_CREATION_TIMING.reducedSurface,
        backendReady: false,
        readySubscriptionAvailable: false,
        reducedMotion: true,
      }).stage,
    ).toBe("surface");

    expect(
      resolveSubscriptionCreationState({
        elapsedMs: SUBSCRIPTION_CREATION_TIMING.reducedModules,
        backendReady: false,
        readySubscriptionAvailable: false,
        reducedMotion: true,
      }).stage,
    ).toBe("modules");

    expect(
      resolveSubscriptionCreationState({
        elapsedMs: 10_000,
        backendReady: true,
        readySubscriptionAvailable: false,
        reducedMotion: true,
      }),
    ).toMatchObject({ stage: "waiting", complete: false });

    expect(
      resolveSubscriptionCreationState({
        elapsedMs:
          SUBSCRIPTION_CREATION_TIMING.reducedIgnition +
          SUBSCRIPTION_CREATION_TIMING.reducedHandoff,
        backendReady: true,
        readySubscriptionAvailable: true,
        readySinceMs: 0,
        reducedMotion: true,
      }),
    ).toMatchObject({ stage: "complete", complete: true });
  });

  it("keeps a terminal failure stable and never complete", () => {
    expect(
      resolveSubscriptionCreationState({
        elapsedMs: 20_000,
        backendReady: true,
        readySubscriptionAvailable: true,
        readySinceMs: 0,
        failed: true,
      }),
    ).toMatchObject({ stage: "failed", complete: false });
  });

  it("wakes React only at one-shot stage and long-wait boundaries", () => {
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: 0,
        ...pending,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(SUBSCRIPTION_CREATION_TIMING.surface);
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: SUBSCRIPTION_CREATION_TIMING.surface,
        ...pending,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(SUBSCRIPTION_CREATION_TIMING.identity);
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: SUBSCRIPTION_CREATION_TIMING.waiting,
        ...pending,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(15_000);
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: 15_000,
        ...pending,
        longWaitAfterMs: 15_000,
      }),
    ).toBeNull();
  });

  it("keeps reduced-motion wake-ups on its compact opacity checkpoints", () => {
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: 0,
        ...pending,
        reducedMotion: true,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(SUBSCRIPTION_CREATION_TIMING.reducedSurface);
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: SUBSCRIPTION_CREATION_TIMING.reducedSurface,
        ...pending,
        reducedMotion: true,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(SUBSCRIPTION_CREATION_TIMING.reducedIdentity);
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: SUBSCRIPTION_CREATION_TIMING.reducedIgnition,
        backendReady: true,
        readySubscriptionAvailable: true,
        readySinceMs: 0,
        reducedMotion: true,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(
      SUBSCRIPTION_CREATION_TIMING.reducedIgnition +
        SUBSCRIPTION_CREATION_TIMING.reducedHandoff,
    );
  });

  it("keeps early READY wake-ups on the natural assembly checkpoints", () => {
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: 0,
        backendReady: true,
        readySubscriptionAvailable: true,
        readySinceMs: 0,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(SUBSCRIPTION_CREATION_TIMING.surface);
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: 2_000,
        backendReady: true,
        readySubscriptionAvailable: true,
        readySinceMs: 0,
        longWaitAfterMs: 15_000,
      }),
    ).toBe(SUBSCRIPTION_CREATION_TIMING.modules);
    expect(
      resolveNextSubscriptionCreationWake({
        elapsedMs: 100,
        backendReady: true,
        readySubscriptionAvailable: true,
        failed: true,
        readySinceMs: 0,
        longWaitAfterMs: 15_000,
      }),
    ).toBeNull();
  });
});
