import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  resolveSubscriptionDeletionState,
  resolveSubscriptionDeletionSweepProgress,
  SUBSCRIPTION_DELETION_TIMING,
} from "../../web/src/features/dashboard/components/subscription-deletion-motion-policy.js";

const motionSource = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-deletion-motion.tsx",
    import.meta.url,
  ),
  "utf8",
);
const motionCss = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-deletion-motion.css",
    import.meta.url,
  ),
  "utf8",
);
const carouselSource = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-carousel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const cardSource = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-card.tsx",
    import.meta.url,
  ),
  "utf8",
);
const dashboardSource = readFileSync(
  new URL(
    "../../web/src/features/dashboard/dashboard-page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const devicesSource = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/devices-list.tsx",
    import.meta.url,
  ),
  "utf8",
);
const creationSource = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-creation-motion.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("subscription deletion presentation policy", () => {
  it("ignites at the left edge and reaches only the 92% hold point", () => {
    expect(resolveSubscriptionDeletionSweepProgress(0)).toBe(0);
    expect(
      resolveSubscriptionDeletionSweepProgress(
        SUBSCRIPTION_DELETION_TIMING.ignition,
      ),
    ).toBe(0);
    expect(resolveSubscriptionDeletionSweepProgress(800)).toBeGreaterThan(0);
    expect(
      resolveSubscriptionDeletionSweepProgress(
        SUBSCRIPTION_DELETION_TIMING.sweep,
      ),
    ).toBe(SUBSCRIPTION_DELETION_TIMING.sweepProgress);

    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: SUBSCRIPTION_DELETION_TIMING.sweep,
        serverStatus: "pending",
        serverSettledAtMs: null,
        reducedMotion: false,
      }),
    ).toMatchObject({
      phase: "holding",
      progress: SUBSCRIPTION_DELETION_TIMING.sweepProgress,
      successComplete: false,
      nextWakeAtMs: null,
    });
  });

  it("keeps a fast success visual until the normal 3.35s exit boundary", () => {
    const input = {
      serverStatus: "success" as const,
      serverSettledAtMs: 100,
      reducedMotion: false,
    };
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: SUBSCRIPTION_DELETION_TIMING.sweep - 1,
        ...input,
      }).phase,
    ).toBe("sweeping");
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: SUBSCRIPTION_DELETION_TIMING.sweep,
        ...input,
      }),
    ).toMatchObject({ phase: "finishing", successComplete: false });
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs:
          SUBSCRIPTION_DELETION_TIMING.sweep +
          SUBSCRIPTION_DELETION_TIMING.finish,
        ...input,
      }),
    ).toMatchObject({
      phase: "complete",
      progress: 1,
      successComplete: true,
    });
    expect(
      SUBSCRIPTION_DELETION_TIMING.sweep +
        SUBSCRIPTION_DELETION_TIMING.finish +
        SUBSCRIPTION_DELETION_TIMING.handoff,
    ).toBe(3_600);
  });

  it("holds a slow request and finishes shortly after its success", () => {
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: 8_000,
        serverStatus: "pending",
        serverSettledAtMs: null,
        reducedMotion: false,
      }).phase,
    ).toBe("holding");
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: 8_000,
        serverStatus: "success",
        serverSettledAtMs: 8_000,
        reducedMotion: false,
      }),
    ).toMatchObject({
      phase: "finishing",
      nextWakeAtMs:
        8_000 + SUBSCRIPTION_DELETION_TIMING.finish,
    });
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: 8_000 + SUBSCRIPTION_DELETION_TIMING.finish,
        serverStatus: "success",
        serverSettledAtMs: 8_000,
        reducedMotion: false,
      }).successComplete,
    ).toBe(true);
  });

  it("rolls back from the actual sweep position after a request error", () => {
    const settledAt = 1_200;
    const rollbackFrom =
      resolveSubscriptionDeletionSweepProgress(settledAt);
    const rolling = resolveSubscriptionDeletionState({
      elapsedMs: settledAt + 1,
      serverStatus: "error",
      serverSettledAtMs: settledAt,
      reducedMotion: false,
    });
    expect(rolling.phase).toBe("rolling-back");
    expect(rolling.rollbackFromProgress).toBe(rollbackFrom);
    expect(rolling.progress).toBeLessThan(rollbackFrom);

    expect(
      resolveSubscriptionDeletionState({
        elapsedMs:
          settledAt + SUBSCRIPTION_DELETION_TIMING.rollback,
        serverStatus: "error",
        serverSettledAtMs: settledAt,
        reducedMotion: false,
      }),
    ).toMatchObject({
      phase: "restored",
      progress: 0,
      restoreComplete: true,
    });
  });

  it("restores from the 92% plateau when a held request fails", () => {
    const state = resolveSubscriptionDeletionState({
      elapsedMs: 9_001,
      serverStatus: "error",
      serverSettledAtMs: 9_000,
      reducedMotion: false,
    });
    expect(state.phase).toBe("rolling-back");
    expect(state.rollbackFromProgress).toBe(
      SUBSCRIPTION_DELETION_TIMING.sweepProgress,
    );
  });

  it("uses no artificial 3.6s wait in reduced-motion mode", () => {
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: 20_000,
        serverStatus: "pending",
        serverSettledAtMs: null,
        reducedMotion: true,
      }).phase,
    ).toBe("reduced-pending");

    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: 100 + SUBSCRIPTION_DELETION_TIMING.reducedFinish - 1,
        serverStatus: "success",
        serverSettledAtMs: 100,
        reducedMotion: true,
      }).successComplete,
    ).toBe(false);
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: 100 + SUBSCRIPTION_DELETION_TIMING.reducedFinish,
        serverStatus: "success",
        serverSettledAtMs: 100,
        reducedMotion: true,
      }).successComplete,
    ).toBe(true);
    expect(
      resolveSubscriptionDeletionState({
        elapsedMs: 100 + SUBSCRIPTION_DELETION_TIMING.reducedRollback,
        serverStatus: "error",
        serverSettledAtMs: 100,
        reducedMotion: true,
      }).restoreComplete,
    ).toBe(true);
  });

  it("masks the real rendered card without interpreting operator theme data", () => {
    expect(motionCss).toContain("clip-path: inset(0 0 0 92%)");
    expect(motionCss).toContain(
      '[data-deletion-phase="complete"]',
    );
    expect(motionCss).toContain(
      '[data-deletion-phase="restored"]',
    );
    expect(motionCss).toContain("clip-path: inset(0 0 0 100%)");
    expect(motionCss).toContain("var(--deletion-accent)");
    expect(motionCss).toContain("subscription-deletion-particle");
    expect(motionSource).toContain("visual?.primary");
    expect(motionSource).not.toContain("cardGradient");
    expect(motionSource).not.toContain("cardEffectProps");
    expect(carouselSource).toContain(
      "visual: resolveSubscriptionCardVisual(",
    );
    expect(carouselSource).toContain(
      "<SubscriptionDeletionMotion",
    );
  });

  it("lets the frozen visual override live branding at the card boundary", () => {
    expect(cardSource).toContain(
      "const resolvedVisual = visual ?? brandingVisual",
    );
    expect(cardSource).toContain("visual={resolvedVisual}");
    expect(carouselSource).toContain(
      "visual={itemDeletion?.visual ?? null}",
    );
    expect(carouselSource).toContain("const currentTarget =");
    expect(carouselSource).toContain("item: currentTarget");
    expect(carouselSource).toContain("currentTarget.slotIndex");
  });

  it("releases the protected snapshot and guard after rollback", () => {
    const restoreStart = carouselSource.indexOf(
      "const restoreDeletionPresentation",
    );
    const renderStart = carouselSource.indexOf(
      "if (count === 0) return null",
    );
    const restoreSource = carouselSource.slice(restoreStart, renderStart);

    expect(restoreStart).toBeGreaterThan(-1);
    expect(restoreSource).toContain("deletionRef.current = null");
    expect(restoreSource).toContain("setDeletion(null)");
    expect(restoreSource).toContain("setDeleteTarget(null)");
    expect(restoreSource).toContain(
      "onDeleteGuardActiveChange?.(false)",
    );
    expect(restoreSource).not.toContain("onActiveItemKeyChange(");
  });

  it("wires the protected sole item before the empty carousel gate", () => {
    const protectedIndex = carouselSource.indexOf(
      "const protectedItem = deletion?.item ?? deleteTarget?.item ?? null",
    );
    const retainedIndex = carouselSource.indexOf(
      "retainCarouselItemDuringDeletion(items, protectedItem)",
    );
    const emptyGateIndex = carouselSource.indexOf(
      "if (count === 0) return null",
    );

    expect(protectedIndex).toBeGreaterThan(-1);
    expect(retainedIndex).toBeGreaterThan(protectedIndex);
    expect(emptyGateIndex).toBeGreaterThan(retainedIndex);
  });

  it("keeps actions and devices aligned with the frozen card", () => {
    expect(dashboardSource).toContain("deleteGuardSubscription");
    expect(dashboardSource).toContain(
      "current ?? canonicalActiveSubscriptionRef.current",
    );
    expect(dashboardSource).toContain("disabled={deleteGuardActive}");
    expect(dashboardSource).toContain(
      "<DevicesList",
    );
    expect(devicesSource).toContain("disabled = false");
    expect(devicesSource).toContain("if (disabled) return");
    expect(devicesSource).toContain(
      "disabled={disabled || regenerateMutation.isPending}",
    );
    expect(devicesSource).toContain(
      "disabled={disabled || revokeMutation.isPending}",
    );
    expect(devicesSource).toContain("open={!disabled && regenerateOpen}");
    expect(devicesSource).toContain(
      "open={!disabled && revokeHwid !== null}",
    );
  });

  it("keeps deletion isolated from the existing creation component", () => {
    expect(creationSource).not.toContain("SubscriptionDeletion");
    expect(creationSource).not.toContain("subscription-deletion");
    expect(creationSource).toContain("<SubscriptionCardFrame");
    expect(creationSource).toContain("subscription-card-motion.css");
  });

  it("uses an opacity-only handoff for reduced motion", () => {
    expect(motionCss).toContain(
      "@keyframes subscription-deletion-handoff-reduced",
    );
    expect(motionCss).toContain(
      "animation-name: subscription-deletion-handoff-reduced",
    );
  });
});
