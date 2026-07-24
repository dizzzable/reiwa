import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_CREATION_TIMING,
  SUBSCRIPTION_DELETION_TIMING,
  resolveNextSubscriptionCreationWake,
  resolveSubscriptionCreationState,
  resolveSubscriptionDeletionDuration,
} from "../../web/src/features/dashboard/components/subscription-card-motion-policy.js";
import {
  resolveSubscriptionCardVisual,
} from "../../web/src/features/dashboard/components/subscription-card-visual.js";
import {
  DEFAULT_BRANDING,
  type Branding,
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

  it("short-circuits motion in reduced mode but still requires real data", () => {
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
        elapsedMs: SUBSCRIPTION_CREATION_TIMING.reducedHandoff,
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

describe("subscription deletion duration", () => {
  it("clamps the full digital exit to a perceptible 1.1-1.4 seconds", () => {
    expect(resolveSubscriptionDeletionDuration(false, 100)).toBe(
      SUBSCRIPTION_DELETION_TIMING.minimum,
    );
    expect(resolveSubscriptionDeletionDuration(false, 2_000)).toBe(
      SUBSCRIPTION_DELETION_TIMING.maximum,
    );
    expect(resolveSubscriptionDeletionDuration(false, Number.NaN)).toBe(
      SUBSCRIPTION_DELETION_TIMING.default,
    );
  });

  it("uses a <=200ms reduced-motion exit", () => {
    expect(resolveSubscriptionDeletionDuration(true, 1_000)).toBe(
      SUBSCRIPTION_DELETION_TIMING.reduced,
    );
    expect(SUBSCRIPTION_DELETION_TIMING.reduced).toBeLessThanOrEqual(200);
  });
});
